use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{collections::HashSet, env, path::PathBuf};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountConfig {
    pub id: String,
    pub platform: String,
    pub display_name: String,
    pub base_url: Option<String>,
    pub token_file: Option<PathBuf>,
    pub upstream_account_id: Option<String>,
    pub management_url: Option<String>,
    pub management_token_file: Option<PathBuf>,
    #[serde(skip)]
    pub management_token: String,
    #[serde(skip)]
    pub token: String,
}
impl AccountConfig {
    pub fn configured(&self) -> bool {
        self.base_url.is_some()
    }
    pub fn adapter(&self) -> &str {
        if self.platform == "wechat" {
            "agent-wechat"
        } else {
            if self.management_url.is_some() {
                "llbot-milky"
            } else {
                "lagrange-milky"
            }
        }
    }
    pub fn url(&self, pieces: &[&str]) -> Result<url::Url> {
        let mut url = url::Url::parse(self.base_url.as_deref().context("upstream unconfigured")?)?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid base URL"))?
            .pop_if_empty()
            .extend(pieces);
        Ok(url)
    }
    pub fn wx_url(&self, pieces: &[&str]) -> Result<url::Url> {
        let mut path = vec![
            "v1",
            "accounts",
            self.upstream_account_id
                .as_deref()
                .context("missing upstream account")?,
        ];
        path.extend(pieces);
        self.url(&path)
    }
}

pub struct Config {
    pub data: PathBuf,
    pub web: PathBuf,
    pub listen: String,
    pub origin: String,
    pub legacy: Option<PathBuf>,
    pub accounts: Vec<AccountConfig>,
    pub password: String,
    pub media_limit: u64,
}
impl Config {
    pub fn load() -> Result<Self> {
        let data = PathBuf::from(env::var("SNSBOX_DATA_DIR").unwrap_or_else(|_| "data".into()));
        let legacy = env::var("SNSBOX_LEGACY_CONFIG")
            .ok()
            .map(PathBuf::from)
            .map(|p| p.canonicalize())
            .transpose()
            .context("legacy config must be an existing read-only directory")?;
        let data = validate_data_location(&data, legacy.as_deref())?;
        std::fs::create_dir_all(&data)?;
        let password = if let Ok(file) = env::var("SNSBOX_ADMIN_PASSWORD_FILE") {
            std::fs::read_to_string(file)?
                .trim_end_matches(['\r', '\n'])
                .to_string()
        } else if let Ok(value) = env::var("SNSBOX_ADMIN_PASSWORD") {
            value
        } else {
            let file = data.join("initial-admin-password");
            if !file.exists() {
                use std::io::Write;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                options.open(&file)?.write_all(
                    format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    )
                    .as_bytes(),
                )?;
                tracing::warn!(
                    "Initial administrator credential created in data/initial-admin-password; read this private file locally"
                );
            }
            std::fs::read_to_string(file)?
        };
        if password.len() < 16 {
            bail!("administrator password must have at least 16 bytes");
        }
        let mut accounts: Vec<AccountConfig> = if let Ok(path) = env::var("SNSBOX_ACCOUNTS_FILE") {
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            serde_json::from_value(serde_json::json!([
                {"id":"wechat-main","platform":"wechat","displayName":"微信"},
                {"id":"qq-main","platform":"qq","displayName":"QQ"}
            ]))?
        };
        let mut ids = HashSet::new();
        for a in &mut accounts {
            if a.id.is_empty()
                || a.id.len() > 100
                || !a
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                || !ids.insert(a.id.clone())
            {
                bail!("invalid or duplicate account id");
            }
            if a.platform != "wechat" && a.platform != "qq" {
                bail!("unknown platform");
            }
            if let Some(base) = &a.management_url {
                let u = url::Url::parse(base)?;
                if a.platform != "qq"
                    || !matches!(u.scheme(), "http" | "https")
                    || u.host_str().is_none()
                    || !u.username().is_empty()
                    || u.password().is_some()
                    || u.query().is_some()
                    || u.fragment().is_some()
                    || u.path() != "/"
                {
                    bail!("managementUrl must be a QQ LLBot http(s) origin");
                }
                if a.upstream_account_id
                    .as_deref()
                    .is_none_or(|s| s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()))
                {
                    bail!("LLBot management requires expected QQ UIN in upstreamAccountId");
                }
                a.management_token = std::fs::read_to_string(
                    a.management_token_file
                        .as_ref()
                        .context("managementTokenFile required")?,
                )?
                .trim()
                .to_string();
                if a.management_token.is_empty() || a.management_token.contains(['\r', '\n']) {
                    bail!("invalid management token");
                }
            }
            if let Some(ref base) = a.base_url {
                let url = url::Url::parse(base)?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || url.path() != "/"
                {
                    bail!(
                        "baseUrl must be an http(s) origin, without credentials, path, query, fragment"
                    );
                }
                if a.platform == "wechat"
                    && a.upstream_account_id.as_deref().is_none_or(str::is_empty)
                {
                    bail!("wechat requires upstreamAccountId");
                }
                a.token = std::fs::read_to_string(
                    a.token_file
                        .as_ref()
                        .context("configured upstream requires tokenFile")?,
                )?
                .trim()
                .to_string();
                if a.token.is_empty() || a.token.contains(['\r', '\n']) {
                    bail!("invalid upstream token file");
                }
            }
        }
        let origin = env::var("SNSBOX_PUBLIC_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:8080".into())
            .trim_end_matches('/')
            .to_string();
        let parsed = url::Url::parse(&origin)?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.origin().ascii_serialization() != origin
        {
            bail!("SNSBOX_PUBLIC_ORIGIN must be an exact http(s) origin");
        }
        Ok(Self {
            data,
            legacy,
            accounts,
            password,
            origin,
            web: env::var("SNSBOX_WEB_DIR")
                .unwrap_or_else(|_| "web/dist".into())
                .into(),
            listen: env::var("SNSBOX_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            media_limit: env::var("SNSBOX_MEDIA_QUOTA_BYTES")
                .ok()
                .map(|x| x.parse())
                .transpose()?
                .unwrap_or(2 * 1024 * 1024 * 1024),
        })
    }
}

// Resolve an existing ancestor (including symlinks) before any mkdir or credential creation.
fn resolve_future_path(path: &std::path::Path) -> Result<PathBuf> {
    use std::path::Component;
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for c in absolute.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            c => normalized.push(c.as_os_str()),
        }
    }
    let mut parent = normalized.as_path();
    let mut missing = vec![];
    while !parent.exists() {
        missing.push(
            parent
                .file_name()
                .context("cannot resolve data directory")?
                .to_owned(),
        );
        parent = parent.parent().context("cannot resolve data ancestor")?;
    }
    let mut resolved = parent.canonicalize()?;
    for part in missing.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

fn validate_data_location(
    data: &std::path::Path,
    legacy: Option<&std::path::Path>,
) -> Result<PathBuf> {
    let data = resolve_future_path(data)?;
    if let Some(legacy) = legacy {
        let legacy = legacy.canonicalize()?;
        if data.starts_with(&legacy) || legacy.starts_with(&data) {
            bail!("SNSBOX_DATA_DIR and legacy config must be separate non-nested directories");
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_data_is_rejected_before_creation() {
        let root = env::temp_dir().join(format!("snsbox-layout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let data = root.join("new-data").join("nested");
        assert!(validate_data_location(&data, Some(&root)).is_err());
        assert!(!root.join("new-data").exists());
        #[cfg(unix)]
        {
            let alias = root.with_extension("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            assert!(validate_data_location(&alias.join("new-data"), Some(&root)).is_err());
            assert!(!root.join("new-data").exists());
            std::fs::remove_file(alias).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
}
