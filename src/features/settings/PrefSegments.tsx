interface TextSegmentsProps<T extends string> {
  value: T;
  values: readonly T[];
  labels: Record<T, string>;
  label: string;
  onChange: (next: T) => void;
}

/** One text-only segmented control for an N-way preference, on the `.segmented` tokens. */
export function TextSegments<T extends string>({
  value,
  values,
  labels,
  label,
  onChange,
}: TextSegmentsProps<T>) {
  return (
    <div
      className="segmented segmented--text"
      role="group"
      aria-label={label}
      data-count={values.length}
    >
      {values.map((option) => (
        <button
          key={option}
          type="button"
          className="seg"
          aria-pressed={value === option}
          onClick={() => {
            onChange(option);
          }}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}
