"use client";

import { useState } from "react";

/** "50,00" / "50.5" / "50" → 5000 grosze; null when not a positive amount with at most 2 decimals. */
export function parseZl(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const grosze = Math.round(Number(normalized) * 100);
  return grosze >= 1 ? grosze : null;
}

export const formatZl = (grosze: number) => (grosze / 100).toFixed(2).replace(".", ",");

type Props = {
  label: string;
  /** Value in grosze, or null when the text is invalid. */
  value: number | null;
  onChange: (grosze: number | null) => void;
  help?: string;
  testId?: string;
};

/** Amount input in złoty; the API always receives integer grosze. */
export function ZlInput({ label, value, onChange, help, testId }: Props) {
  const [text, setText] = useState(value === null ? "" : formatZl(value));
  const invalid = parseZl(text) === null;
  return (
    <label className="block">
      <span className="font-bold">{label}</span>
      <span className="mt-1 flex items-center gap-1">
        <input
          inputMode="decimal"
          value={text}
          data-testid={testId}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseZl(e.target.value));
          }}
          onBlur={() => {
            const g = parseZl(text);
            if (g !== null) setText(formatZl(g));
          }}
          className={`w-32 rounded border px-2 py-1 text-right ${invalid ? "border-red-500" : ""}`}
        />
        <span>zł</span>
      </span>
      {invalid ? <span className="text-xs text-red-600">Podaj kwotę, np. 50 albo 12,50.</span> : help && <span className="text-xs text-zinc-500">{help}</span>}
    </label>
  );
}
