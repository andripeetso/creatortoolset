import { useEffect, useState, type ReactNode } from "react";

/**
 * Destructive actions take two clicks: the first arms the button and
 * changes its label, the second fires. It disarms by itself after a few
 * seconds or when focus leaves, so a stray click never deletes anything.
 */
export function ConfirmButton({
  label,
  confirmLabel = "Click again to delete",
  onConfirm,
  className = "",
  armedClassName = "",
  disabled,
  title,
  icon,
}: {
  label: ReactNode;
  confirmLabel?: ReactNode;
  onConfirm: () => void | Promise<void>;
  className?: string;
  armedClassName?: string;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={armed}
      title={armed ? "Second click confirms" : title}
      onBlur={() => setArmed(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        void onConfirm();
      }}
      className={`${className} ${armed ? armedClassName : ""}`}
    >
      {icon}
      {armed ? confirmLabel : label}
    </button>
  );
}
