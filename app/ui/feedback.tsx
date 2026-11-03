import type { ButtonHTMLAttributes, ReactNode } from "react";

type SpinnerProps = {
  label: string;
};

export function Spinner({ label }: SpinnerProps) {
  return (
    <span className="loading-spinner" role="status" aria-label={label} />
  );
}

type LoadingButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy: boolean;
  busyLabel: string;
  children: ReactNode;
  success?: boolean;
  successLabel?: string;
};

export function LoadingButton({
  busy,
  busyLabel,
  children,
  success = false,
  successLabel = "Saved",
  disabled,
  ...props
}: LoadingButtonProps) {
  return (
    <button {...props} disabled={disabled || busy} aria-busy={busy && !success}>
      {success
        ? <><span aria-hidden="true">✓</span> {successLabel}</>
        : busy
          ? <><Spinner label={busyLabel} /> {busyLabel}</>
          : children}
    </button>
  );
}

type SkeletonProps = {
  className: string;
};

export function Skeleton({ className }: SkeletonProps) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}
