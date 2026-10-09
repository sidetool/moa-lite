import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import { cx } from "../lib/format";
import { remoteKey } from "../lib/remote";

type Variant = "primary" | "secondary" | "ghost" | "accent";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "m" | "l";
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "m", icon, className, children, ...rest }, ref) {
  return (
    <button ref={ref} className={cx("btn", `btn-${variant}`, `btn-${size}`, !children && "btn-icon-only", className)} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  );
});

export function ButtonLink({ to, variant = "secondary", size = "m", icon, children, className }: { to: string; variant?: Variant; size?: "m" | "l"; icon?: ReactNode; children: ReactNode; className?: string }) {
  return <Link to={to} className={cx("btn", `btn-${variant}`, `btn-${size}`, className)}>{icon}<span>{children}</span></Link>;
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} title={label} className={cx("icon-btn", className)} {...rest}>{children}</button>;
}

export function ConfirmDialog({ title, children, confirmLabel = "확인", busy = false, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel?: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => {
      if (remoteKey(event.nativeEvent) === "Back") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
      if (event.key === "Tab") {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); if (!busy && event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); }}>
    <header className="sheet-head"><h2 id={`${id}-title`}>{title}</h2></header>
    <div className="confirm-dialog-body" id={`${id}-body`}>{children}</div>
    <footer className="sheet-foot"><Button type="button" autoFocus disabled={busy} onClick={onClose}>취소</Button><Button type="button" variant="primary" disabled={busy} onClick={onConfirm}>{busy ? "처리 중…" : confirmLabel}</Button></footer>
  </dialog>;
}

// Older TV browsers lack the Popover API; Select falls back to a native <select> there.
const popoverSupported = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function" && typeof HTMLElement.prototype.hidePopover === "function";

export function Select({ value, options, onChange, className, disabled, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange" | "children"> & { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const position = useRef({ top: 0, left: 0 });
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.findIndex(option => option.value === value);
  const close = () => { if (popoverSupported) menu.current?.hidePopover(); setOpen(false); };
  const show = () => {
    const button = trigger.current, list = menu.current;
    if (!button || !list || disabled || !options.length) return;
    const view = button.ownerDocument.defaultView;
    if (!view) return;
    const rect = button.getBoundingClientRect();
    position.current = rect;
    const width = Math.min(Math.max(rect.width, 180), view.innerWidth - 24);
    const below = view.innerHeight - rect.bottom - 18, above = rect.top - 18;
    list.style.width = `${width}px`;
    list.style.maxHeight = `${Math.max(48, Math.min(320, Math.max(below, above)))}px`;
    list.style.left = `${Math.max(12, Math.min(rect.left, view.innerWidth - width - 12))}px`;
    list.showPopover();
    list.style.top = `${below >= list.offsetHeight || below >= above ? rect.bottom + 6 : Math.max(12, rect.top - list.offsetHeight - 6)}px`;
    setActive(Math.max(0, selected));
    setOpen(true);
  };
  const choose = (index: number) => { if (options[index]) onChange(options[index].value); close(); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const view = trigger.current?.ownerDocument.defaultView;
    if (!view) return;
    const dismiss = (event: Event) => {
      const rect = trigger.current?.getBoundingClientRect();
      if (event.type === "resize" || rect?.top !== position.current.top || rect?.left !== position.current.left) close();
    };
    view.addEventListener("resize", dismiss);
    view.addEventListener("scroll", dismiss, true);
    return () => { view.removeEventListener("resize", dismiss); view.removeEventListener("scroll", dismiss, true); };
  }, [open]);
  useEffect(() => { if (open) menu.current?.children[active]?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  if (!popoverSupported) {
    return <span className={cx("dropdown", className)}>
      <select id={rest.id} name={rest.name} title={rest.title} autoFocus={rest.autoFocus} tabIndex={rest.tabIndex} aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]} aria-describedby={rest["aria-describedby"]}
        className="dropdown-trigger" disabled={disabled || !options.length} value={value} onChange={event => onChange(event.target.value)}>
        {selected < 0 && <option value={value} hidden>{value}</option>}
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </span>;
  }
  return <span className={cx("dropdown", className)}>
    <button {...rest} ref={trigger} type="button" className="dropdown-trigger" disabled={disabled || !options.length} popoverTarget={id} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={event => { event.preventDefault(); if (open) close(); else show(); }} onKeyDown={event => {
        const key = remoteKey(event.nativeEvent);
        if (key === "Tab") { close(); return; }
        if (key === "Back" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
          event.preventDefault(); event.stopPropagation();
          if (!open) { show(); if (key === "End") setActive(options.length - 1); }
          else if (key === "Enter" || key === " ") choose(active);
          else setActive(index => key === "Home" ? 0 : key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (key === "ArrowDown" ? 1 : -1))));
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); event.stopPropagation();
          const now = Date.now();
          search.current = { text: now - search.current.time < 700 ? search.current.text + event.key : event.key, time: now };
          const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(search.current.text.toLocaleLowerCase()));
          if (index >= 0) { if (open) setActive(index); else onChange(options[index].value); }
        }
      }}>
      <span>{options[selected]?.label ?? value}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    <div ref={menu} id={id} popover="auto" className="dropdown-menu" role="listbox" aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]}
      onToggle={event => setOpen(event.newState === "open")} onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
      {options.map((option, index) => <button key={option.value} id={`${id}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={option.value === value} className={cx("dropdown-option", index === active && "is-active")}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <Check size={16} aria-hidden="true" />}
      </button>)}
    </div>
  </span>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={cx("switch", checked && "is-on")} onClick={() => onChange(!checked)}><i /></button>;
}

export function ProgressBar({ ratio, className }: { ratio: number; className?: string }) {
  return <span className={cx("progress", className)} aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} /></span>;
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={cx("sk", className)} style={style} aria-hidden="true" />;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 28 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="불러오는 중" />;
}
