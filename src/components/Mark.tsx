export function Mark({ size = 17 }: { size?: number }) {
  return (
    <svg viewBox="0 0 220.37 220.37" width={size} height={size} aria-hidden="true" style={{ flex: "none" }}>
      <polygon fill="#ff514b" points="0 0 0 64.25 155.77 64.25 155.77 220.37 220.37 220.37 220.37 0 0 0" />
    </svg>
  );
}
