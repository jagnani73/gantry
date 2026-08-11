import { CATEGORY_LABELS, type MerchantSummary } from "@gantry/shared";
import { Card, Chip, Mono } from "@/components/primitives";
import { ShopTile } from "@/components/merchant/shop-tile";
import { shortDate } from "@/components/merchant/format";

/**
 * One shop in the grid.
 *
 * A real `<button>`, not a div with an onClick: the whole card opens the drawer,
 * so it has to be reachable and operable from a keyboard like any other control.
 * Its accessible name is the shop's own, which is what someone listening is
 * choosing between.
 *
 * The footer row carries the category and the registration date, and nothing
 * else. An "accepts agents" badge would be true of every merchant on the rail —
 * nothing on-chain lets a shop opt out of a door, and the only thing that can
 * refuse an agent is the payer's own spend policy — so it would be decoration
 * wearing the accent colour. The date earns the slot instead: the grid is
 * ordered by registration, and reading that column down is what makes the order
 * legible rather than arbitrary.
 *
 * Every category chip is accent, as on every other Gantry surface. The design
 * file tinted Food & Beverage alone and greyed the rest, which on a real grid
 * reads as a recommendation — the one thing a directory disclaiming curation
 * must not do.
 */
export function MerchantCard({
  merchant,
  onOpen,
}: {
  merchant: MerchantSummary;
  onOpen: () => void;
}) {
  const name = merchant.displayName ?? merchant.handle;
  return (
    <Card
      as="button"
      radius="card-m"
      hover
      onClick={onOpen}
      aria-label={`${name}: merchant details`}
      className="flex w-full flex-col gap-4 text-left"
    >
      <div className="flex items-start gap-3.5">
        {/* The shop's own name, or the striped empty slot when it has none —
            never the handle, which would draw initials the shop never chose. */}
        <ShopTile name={merchant.displayName ?? ""} size="md" />
        <div className="min-w-0 flex-1">
          {/* Wraps to two lines and clamps at three. A 30-character shop name is
              ordinary, and truncating one to fit a card is how a directory stops
              being usable for the shops that most need finding. */}
          <div className="text-card-title-m line-clamp-3">{name}</div>
          <Mono size="2xs" tone="faint" truncate className="mt-1.25">
            @{merchant.handle}
          </Mono>
        </div>
      </div>

      {merchant.location ? <p className="text-body-sm text-quiet">{merchant.location}</p> : null}

      {/* `mt-auto` pins this to the bottom whatever the name and location did
          above it, so the rule lines up across a row of cards. It WRAPS rather
          than truncating under ~300px of card width: the category is what an
          agent's policy reads, and the date is what orders the grid — neither is
          the one to drop. */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2.5 gap-y-2 border-t border-fill-subtle pt-4">
        <Chip tone="accent">
          {CATEGORY_LABELS[merchant.categoryId] ?? merchant.categoryName}
        </Chip>
        <span className="text-fine text-faintest">{shortDate(merchant.registeredAt)}</span>
      </div>
    </Card>
  );
}
