/**
 * The design system's semantic layer.
 *
 * These exist because the rules they carry are semantic, not stylistic: "a
 * quantity is mono with tabular-nums", "a declined attempt is struck through and
 * excluded from totals", "an amount is 6dp integer units and never a float". A
 * rule re-typed on every screen is a rule that holds on most screens.
 */
export { cn } from "./cn";
export { TEXT_TONE, type Tone } from "./tone";
export { formatUnits, percentOf, toUnits, type Units } from "./units";

export { CapMeter, type CapMeterProps } from "./cap-meter";
export { Card, type CardProps } from "./card";
export { Chip, type ChipProps } from "./chip";
export { DOOR_LABEL, DoorChip, type DoorChipProps, type DoorKind } from "./door-chip";
export { Figure, type FigureProps } from "./figure";
export { GantryMark } from "./gantry-mark";
export { KeyValue, KeyValueList, type KeyValueProps } from "./key-value";
export { Label, type LabelProps } from "./label";
export { Money, type MoneyProps } from "./money";
export { Mono, type MonoProps } from "./mono";
export { Row, type RowProps } from "./row";
export { StatusDot, type StatusDotProps } from "./status-dot";
export { ToastProvider, useToast, type ToastTone } from "./toast";
