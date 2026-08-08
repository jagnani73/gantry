/**
 * What a table says when it has nothing to say.
 *
 * Empty states here are typographic by design — no illustration — and they are
 * load-bearing rather than decorative: "no payments yet" and "this screen cannot
 * see the payments that are happening" look identical if the copy is lazy, and
 * only one of them is the merchant's problem.
 */
export function EmptyPanel({
  title,
  body,
  action,
  glyph = true,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  /** The neutral tile above the title. Off inside a table that already has one. */
  glyph?: boolean;
}) {
  return (
    <div className="px-6 pt-11 pb-13 text-center">
      {glyph ? <div aria-hidden className="mx-auto size-11 rounded-tile bg-fill-subtle" /> : null}
      <div className={glyph ? "mt-4.5 text-card-title-sm" : "text-card-title-xs"}>{title}</div>
      <p className="mx-auto mt-2 max-w-[46ch] text-body-sm text-muted">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
