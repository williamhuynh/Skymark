type Props = {
  size?: number;
};

export function Logo({ size = 20 }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden
      focusable={false}
    >
      <circle cx="12" cy="12" r="9.5" stroke="var(--accent)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="3.5" fill="var(--accent)" />
    </svg>
  );
}
