'use client';

import { RadioGroup, RadioGroupItem } from '@inflect/ui/components/ui/radio-group';

/** A labelled radio group over a closed set of values. */
export function ChoiceGroup<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-tight">
      <legend className="mb-tight text-sm font-medium text-content-emphasis">{label}</legend>
      <RadioGroup name={name} value={value} onValueChange={(v) => onChange(v as T)} className="flex flex-wrap gap-default">
        {options.map((option) => (
          <label key={option.value} className="flex cursor-pointer items-center gap-tight text-content-default">
            <RadioGroupItem value={option.value} data-testid={`${name}-${option.value}`} />
            {option.label}
          </label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
