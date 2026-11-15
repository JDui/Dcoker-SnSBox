import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as Dropdown from '@radix-ui/react-dropdown-menu'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'
import { cn } from '../lib/utils'

// shadcn/ui composition pattern, using Radix for focus trapping, dismissal and keyboard navigation.
const buttonVariants = cva('button', {
  variants: {
    variant: { default: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' },
    size: { default: '', sm: 'button-small', icon: 'button-icon' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
})
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) =>
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />)
Button.displayName = 'Button'

export function Tooltip({ children, label }: { children: ReactNode; label: string }) {
  return <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal><TooltipPrimitive.Content className="tooltip" sideOffset={8}>{label}<TooltipPrimitive.Arrow /></TooltipPrimitive.Content></TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
}
export function IconButton({ label, children, ...props }: ButtonProps & { label: string }) {
  return <Tooltip label={label}><Button type="button" variant="ghost" size="icon" aria-label={label} {...props}>{children}</Button></Tooltip>
}
export const TooltipProvider = TooltipPrimitive.Provider

export function Modal({ open, onOpenChange, title, description, children, className }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; className?: string
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="modal-overlay" />
      <DialogPrimitive.Content className={cn('modal', className)}>
        <div className="modal-heading"><div><DialogPrimitive.Title>{title}</DialogPrimitive.Title><DialogPrimitive.Description>{description}</DialogPrimitive.Description></div>
          <DialogPrimitive.Close asChild><Button variant="ghost" size="icon" aria-label="关闭"><X size={19} /></Button></DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
}

export function Menu({ trigger, children, label }: { trigger: ReactNode; children: ReactNode; label: string }) {
  return <Dropdown.Root><Dropdown.Trigger asChild><Button type="button" variant="ghost" size="icon" aria-label={label}>{trigger}</Button></Dropdown.Trigger>
    <Dropdown.Portal><Dropdown.Content className="menu-content" align="end" sideOffset={8}>{children}</Dropdown.Content></Dropdown.Portal>
  </Dropdown.Root>
}
export function MenuItem({ children, onSelect, disabled = false }: { children: ReactNode; onSelect: () => void; disabled?: boolean }) {
  return <Dropdown.Item className="menu-item" onSelect={onSelect} disabled={disabled}>{children}</Dropdown.Item>
}
