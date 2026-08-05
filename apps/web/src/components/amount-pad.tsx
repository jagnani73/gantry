"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"] as const;

function isValidAmount(value: string, max: number): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0 && Number(value) <= max;
}

export function AmountPad({
  value,
  onChange,
  onSubmit,
  max = 9999,
  maxHint,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  max?: number;
  maxHint?: string;
}) {
  const press = (key: (typeof KEYS)[number]) => {
    if (key === "⌫") {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === "." && (value.includes(".") || value === "")) return;
    if (/^\d/.test(key)) {
      const [, decimals] = value.split(".");
      if (decimals && decimals.length >= 2) return;
      if (!value.includes(".") && value.replace(/^0+/, "").length >= 4) return; // cap S$9999
    }
    onChange(value === "0" && key !== "." ? key : value + key);
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-baseline justify-center gap-1 py-2">
          <span className="text-2xl text-muted-foreground">S$</span>
          <span className="min-w-24 text-center text-5xl font-bold tabular-nums">
            {value || "0"}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <Button
              key={key}
              variant="secondary"
              className="h-14 text-xl"
              onClick={() => press(key)}
            >
              {key}
            </Button>
          ))}
        </div>
        <Button
          size="lg"
          className="w-full"
          disabled={!isValidAmount(value, max)}
          onClick={onSubmit}
        >
          Pay{value && isValidAmount(value, max) ? ` S$${value}` : ""}
        </Button>
        {value && Number(value) > max && (
          <p className="text-center text-xs text-muted-foreground">
            {maxHint ?? `Maximum S$${max}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
