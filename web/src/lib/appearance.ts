export type AccentName = 'blue' | 'teal' | 'violet' | 'rose'
type Palette = { main: string; hover: string; soft: string; text: string; foreground: string }
export const accentPresets: { id: AccentName; label: string; light: Palette; dark: Palette }[] = [
  { id: 'blue', label: '蓝色', light: { main: '#315faa', hover: '#284f8e', soft: '#e9eef8', text: '#2d5797', foreground: '#ffffff' }, dark: { main: '#95b6f6', hover: '#b0c9fa', soft: '#2d3850', text: '#abc6fa', foreground: '#121722' } },
  { id: 'teal', label: '青色', light: { main: '#087568', hover: '#065e54', soft: '#e1f2ef', text: '#066657', foreground: '#ffffff' }, dark: { main: '#7bcfc0', hover: '#a0ddcf', soft: '#243e3c', text: '#a0e1d6', foreground: '#121722' } },
  { id: 'violet', label: '紫色', light: { main: '#7151ad', hover: '#5f4296', soft: '#efeaf8', text: '#65479d', foreground: '#ffffff' }, dark: { main: '#c0a4ef', hover: '#d2bef7', soft: '#393247', text: '#d4bef5', foreground: '#121722' } },
  { id: 'rose', label: '玫瑰', light: { main: '#a5486a', hover: '#8b3c59', soft: '#f9e9ef', text: '#913f5c', foreground: '#ffffff' }, dark: { main: '#eaa0ba', hover: '#f2bad0', soft: '#49303c', text: '#efbed0', foreground: '#121722' } },
]
export const normalizeAccent = (value: string): AccentName => accentPresets.find(preset => preset.id === value)?.id || 'blue'
export function applyAccent(name: AccentName, dark: boolean) {
  const preset = accentPresets.find(value => value.id === name) || accentPresets[0]
  const palette = preset[dark ? 'dark' : 'light']
  for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key === 'main' ? '--accent' : `--accent-${key}`, value)
  document.documentElement.dataset.accent = preset.id
}
