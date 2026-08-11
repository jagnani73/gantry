"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BASE_SEPOLIA_ADDRESSES,
  CATEGORY_LABELS,
  PROFILE_LIMITS,
  basescanAddress,
  normalizeProfile,
  profileFieldLength,
  shortAddress,
  type MerchantProfile,
  type ProfileField,
} from "@gantry/shared";
import { Card, Chip, Label, Mono, useToast } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, ApiClientError } from "@/lib/api";
import { shortDate } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { ShopTile } from "./shop-tile";
import { Toggle } from "./toggle";

/**
 * The shop's public identity, plus the two settings that are not a number.
 *
 * This was two screens — Shop profile and Settings — until the read-only one was
 * found to own nothing. It listed payout address, handle, category and
 * registration date, and every one of those is rendered better elsewhere: payout
 * on Payouts, with the rotation rule and a Basescan link, and again in the
 * sidebar footer; handle and category as the locked fields on this form, beside
 * the reason each is locked; the registration date in the payer preview. What
 * was left over was a chime toggle and three Basescan links, which is not a
 * screen. The rows are gone rather than moved — a fourth rendering of the same
 * on-chain facts is not what a merchant was missing.
 *
 * Validated with `normalizeProfile` from `@gantry/shared` — the same function the
 * API runs — rather than with a local copy of the limits. A form that knows only
 * the ceilings still drifts on the rules: it would accept a direction-override
 * the API rejects and surface that as a mystery 400.
 *
 * Two fields render locked, for two different reasons. The handle is claimed
 * on-chain and permanent. The category is on-chain too and GantryCore ships no
 * setter for it, so nothing in this app can change it — showing an editable
 * select would promise something no request could deliver.
 */

const EMPTY: MerchantProfile = { displayName: "", location: "", blurb: "" };

/**
 * The field a SERVER-side validation error names, when it names one.
 *
 * `ApiClientError.args` carries it, and dropping it rendered the message as an
 * unattached paragraph while the guilty input stayed unmarked — the `aria-invalid`
 * wiring already exists and was simply never fed from this direction. Narrowed
 * against the real field names rather than trusted: `args` is `unknown`, and a
 * bad value here would put `aria-invalid` on nothing.
 */
function serverField(err: unknown): ProfileField | undefined {
  if (!(err instanceof ApiClientError) || !Array.isArray(err.args)) return undefined;
  const named = String(err.args[0]);
  return (Object.keys(EMPTY) as ProfileField[]).find((field) => field === named);
}

const FIELD_HELP: Partial<Record<ProfileField, string>> = {
  blurb: "One line. It appears on the payer's view of your shop.",
};

/** Named for the shop, not for the variable — `mockXsgd` has to read as a mock
 * everywhere it appears, and `realUsdc` is deliberately absent: a merchant is
 * never paid in it. */
const CONTRACTS = [
  { name: "GantryCore", address: BASE_SEPOLIA_ADDRESSES.gantryCore },
  { name: "FixedRateSwap", address: BASE_SEPOLIA_ADDRESSES.fixedRateSwap },
  { name: "XSGD (testnet mock)", address: BASE_SEPOLIA_ADDRESSES.mockXsgd },
] as const;

/**
 * No `saved` state: a successful save is a TOAST.
 *
 * It went that way because the inline "Saved." had nowhere useful to sit — it
 * appeared above the button that had just been disabled (the form resets to the
 * saved values, so `dirty` goes false), which is the least-looked-at place on
 * the screen at that moment. Errors stay inline and stay put: a toast is
 * unreadable to anyone who looked away, and a refused save is exactly what a
 * merchant needs to still be able to read.
 */
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string; field?: ProfileField };

export function SettingsScreen() {
  const { handle, merchant, chime, replace } = useMerchantContext();
  const toast = useToast();

  const loaded = useMemo<MerchantProfile>(
    () => ({
      displayName: merchant?.displayName ?? "",
      location: merchant?.location ?? "",
      blurb: merchant?.blurb ?? "",
    }),
    [merchant],
  );

  const [draft, setDraft] = useState<MerchantProfile>(loaded);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  // A save elsewhere (or the first load landing after this screen mounted)
  // should not be overwritten by a stale draft the merchant never touched.
  useEffect(() => setDraft(loaded), [loaded]);

  const dirty = (Object.keys(EMPTY) as ProfileField[]).some(
    (field) => draft[field] !== loaded[field],
  );

  const set = (field: ProfileField, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setSave({ kind: "idle" });
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = normalizeProfile(draft);
    if (!result.ok) {
      setSave({ kind: "error", message: result.message, field: result.field });
      return;
    }
    setSave({ kind: "saving" });
    try {
      replace(await api.updateMerchantProfile(handle, result.value));
      setSave({ kind: "idle" });
      // The toast carries WHY it matters, not just that it happened — that half
      // of the old inline line is the only part a merchant could not work out
      // from the form resetting itself.
      // Names the WRITE, because it is a chain write now: a merchant who sees
      // "saved" over a several-second wait should know what they waited for.
      toast.success("Shop profile saved on-chain. Every payer surface reads this record.");
    } catch (err) {
      // Logged with the handle, matching every other failure path in this app.
      // Without it a merchant reporting "it said Failed to fetch" leaves no
      // status, no error name and no shop in the console to work from.
      console.warn(`gantry: profile save failed for ${handle}`, err);
      // The API's messages are written for a person to read (the disabled-host
      // one explains why it is off), so they are surfaced verbatim.
      const message = err instanceof ApiClientError || err instanceof Error ? err.message : String(err);
      // A transport failure is NOT a verdict. The server does a chain-touching
      // read before it writes, and on a cold host that read is the slow part —
      // so "client gave up at 12s" and "the write landed" are the SAME run, not
      // alternatives. Calling it failed sends a merchant to re-save a profile
      // that is already stored, which is how they collect the 429 on top. Same
      // reasoning as the compensation invariant, one layer up.
      //
      // Deliberately NOT re-read automatically: `reload()` flips the provider to
      // `loading`, which swaps this screen for the gate and destroys the draft.
      // Three names, and the server owns the third. `RequestTimeout`/`NetworkError`
      // are minted by this app's own transport when IT gives up; `ProfileWriteUnresolved`
      // is the backend saying the transaction was broadcast and it could not confirm
      // it — which is the LIKELIEST unknown outcome, since the relayer caps its
      // receipt wait at 20s behind a queue shared with settlements. That case used
      // to arrive as `InternalError` and match nothing here, so the one failure most
      // likely to have actually landed was the one presented as definite.
      const unresolved =
        err instanceof ApiClientError &&
        (err.errorName === "RequestTimeout" ||
          err.errorName === "NetworkError" ||
          err.errorName === "ProfileWriteUnresolved");
      setSave({
        kind: "error",
        message: unresolved
          ? `${message} Your change may still have been saved. Reload this screen to see what is stored before sending it again.`
          : message,
        // The server names the offending field in `args[0]`, and the machinery to
        // point at it already exists. Web and backend deploy independently, so
        // their copies of the shared rules can differ — which is exactly when a
        // server-side field error arrives that the client pre-check let through.
        field: serverField(err),
      });
      // The inline card is the record; the toast is what gets NOTICED — and it is
      // the only one that survives this screen unmounting. The merchant screens
      // are routes, so navigating away mid-request makes `setSave` a silent
      // no-op, and on a production host this route ALWAYS 403s, so that was the
      // default outcome rather than an edge case. Same split, and the same
      // reasoning, as the payer's wallet top-up.
      toast.error(`Shop profile not saved. ${message}`);
    }
  }

  const preview: MerchantProfile = {
    displayName: draft.displayName.trim() || handle,
    location: draft.location.trim(),
    blurb: draft.blurb.trim(),
  };

  return (
    <>
      {/* Says what the screen HAS. It used to end "…and the account behind it",
          written when Settings still listed payout, handle, category and the
          registration date — four rows the merge deleted rather than moved,
          because each is rendered better elsewhere. Promising "the account" over
          two locked fields and three explorer links advertises exactly what a
          merchant would then go looking for. */}
      <ScreenHeader title="Settings">
        What a payer sees before they hand over money, plus this shop&apos;s own preferences.
      </ScreenHeader>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1fr_392px]">
        <Card as="form" radius="card" pad="lg" onSubmit={submit} className="flex flex-col gap-5.5">
          <div>
            <Label>Shop profile</Label>
            {/* Grid, not flex, from `sm` up: the tile is square and takes its
                height from the field stack beside it, and only a grid track
                feeds a stretched height back into an `aspect-square` width. A
                stretched FLEX item keeps its content width (measured: 22px wide,
                150 tall), so the same classes on a flex row draw a sliver. */}
            <div className="mt-3.5 flex flex-wrap items-start gap-5 sm:grid sm:grid-cols-[auto_1fr] sm:items-stretch">
              <ShopTile
                name={preview.displayName}
                size="lg"
                className="sm:size-auto sm:aspect-square"
              />
              <div className="min-w-56 flex-1">
                <Field
                  field="displayName"
                  label="Display name"
                  value={draft.displayName}
                  onChange={set}
                  invalid={save.kind === "error" && save.field === "displayName"}
                />
                <div className="mt-3.5">
                  <FieldLabel>Handle · permanent, claimed on-chain</FieldLabel>
                  <div className="mt-1.5 flex items-center justify-between gap-3 rounded-control bg-fill-subtle px-3.5 py-2.75">
                    <Mono size="md" tone="muted" truncate className="text-body">
                      @{handle}
                    </Mono>
                    <Mono size="2xs" tone="faint">
                      locked
                    </Mono>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Category</FieldLabel>
              <div className="mt-1.5 flex items-center justify-between gap-3 rounded-control bg-fill-subtle px-3.5 py-2.75">
                <span className="text-body-lg text-muted">
                  {merchant === null
                    ? "…"
                    : (CATEGORY_LABELS[merchant.categoryId] ?? merchant.categoryName)}
                </span>
                <Mono size="2xs" tone="faint">
                  locked
                </Mono>
              </div>
              <p className="mt-2 text-fine text-faint">
                Written to GantryCore at registration and read by agent spend policies. The
                contract has no setter for it, so it cannot be changed from here.
              </p>
            </div>
            <Field
              field="location"
              label="Location"
              value={draft.location}
              onChange={set}
              invalid={save.kind === "error" && save.field === "location"}
            />
          </div>

          <Field
            field="blurb"
            label="One line about the shop"
            value={draft.blurb}
            onChange={set}
            invalid={save.kind === "error" && save.field === "blurb"}
          />

          {save.kind === "error" ? (
            <p role="alert" className="text-meta text-danger">
              {save.message}
            </p>
          ) : null}

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" disabled={!dirty || save.kind === "saving"}>
              {save.kind === "saving" ? "Saving…" : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!dirty || save.kind === "saving"}
              onClick={() => {
                setDraft(loaded);
                setSave({ kind: "idle" });
              }}
            >
              Discard
            </Button>
          </div>
        </Card>

        <Card tone="sunken" radius="card" pad="none" className="p-5.5">
          <Label>What a payer sees</Label>
          <Card radius="control-m" pad="none" className="mt-3.5 p-5.5">
            <div className="flex items-center gap-3.5">
              <ShopTile name={preview.displayName} />
              <div className="min-w-0">
                <div className="text-card-title">{preview.displayName}</div>
                {preview.location ? (
                  <div className="mt-0.75 text-meta-sm text-muted">{preview.location}</div>
                ) : null}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {merchant ? (
                <Chip tone="accent">
                  {CATEGORY_LABELS[merchant.categoryId] ?? merchant.categoryName}
                </Chip>
              ) : null}
              {/* "Registered", not "Verified": registration is permissionless and
                  self-attested, and "verified" would imply a KYC step nobody ran. */}
              <Chip>Registered on-chain</Chip>
            </div>
            {preview.blurb ? (
              <p className="mt-4 border-t border-fill-subtle pt-4 text-meta text-muted">
                {preview.blurb}
              </p>
            ) : null}
            {/* The registration date renders as nothing while it is absent, never
                as "Unknown" and never as an estimate. The backend walks
                MerchantRegistered logs in amortised passes, so a cold process
                answers "not yet" for the first minute — and this is the one fact
                a shop would cite as proof it existed. */}
            {merchant ? (
              <Mono size="3xs" tone="faintest" className="mt-3.5 block">
                merchant {shortAddress(merchant.merchantId)}
                {merchant.registeredAt === undefined
                  ? null
                  : ` · registered ${shortDate(merchant.registeredAt)}`}
              </Mono>
            ) : null}
          </Card>
          {/* The chip is a claim about the HANDLE, and the name sitting above it
              is not covered by it. These fields went ON-CHAIN on 11 Aug 2026 —
              which changes where they are stored and changes nothing about
              whether they are true. Self-attested text in a contract is still
              self-attested; the honest-labels rule is what stops "on-chain" from
              quietly reading as "verified" on the one screen that puts the two
              next to each other. */}
          <p className="mt-3.5 text-fine text-quiet">
            The name, location and one-liner are yours to write. They live in GantryCore now, so
            every payer surface reads the same record, but nobody verifies them, and
            &ldquo;registered&rdquo; means a contract call anyone can make, not a check anyone
            ran. The handle and category cannot change at all: the handle is claimed permanently
            and the contract ships no setter for the category.
          </p>
          <p className="mt-2.5 text-fine text-quiet">
            Payers reach this from a receipt or from a shop they have paid before. It carries
            nothing about your balance or your payouts.
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1fr_392px]">
        <Card radius="card" pad="none" className="px-6 py-5.5">
          <Label>Chime on new payment</Label>
          <p className="mt-2.5 mb-3.5 text-meta text-muted">
            A short tone when a settlement lands. Browsers need one tap on the page before they
            will play sound, so it arms itself the first time you click anything.
          </p>
          <div className="flex items-center gap-3">
            <Toggle
              checked={chime.on}
              // Handled, not discarded. `set` now swallows its own two failure
              // modes, so this only catches something unforeseen — but `void` on
              // an async call is a standing promise that nothing will ever throw
              // out of it, which is not a promise this call site can make.
              onChange={(next) => {
                chime.set(next).catch((err: unknown) => {
                  console.warn("gantry: chime toggle failed", err);
                });
              }}
              label="Chime on new payment"
            />
            <span className="text-body text-quiet">
              {!chime.on ? "Off" : chime.armed ? "On" : "On · waiting for a tap"}
            </span>
          </div>
        </Card>

        <Card radius="card" pad="none" className="px-6 py-5.5">
          <Label>Contracts</Label>
          <div className="mt-3.5 flex flex-col gap-2">
            {CONTRACTS.map((contract) => (
              <div key={contract.name} className="flex items-center justify-between gap-4">
                <Mono size="sm" tone="muted">
                  {contract.name}
                </Mono>
                <a
                  className="focus-ring rounded-badge"
                  href={basescanAddress(contract.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Mono size="sm">{shortAddress(contract.address)} ↗</Mono>
                </a>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-meta-sm text-faint">{children}</span>;
}

function Field({
  field,
  label,
  value,
  invalid,
  onChange,
}: {
  field: ProfileField;
  label: string;
  value: string;
  invalid: boolean;
  onChange(field: ProfileField, value: string): void;
}) {
  const limit = PROFILE_LIMITS[field];
  // Codepoints, not `String.length`: UTF-16 units disagree with the limit on
  // exactly the inputs — emoji, most non-Latin scripts — a counter warns about.
  const used = profileFieldLength(value);
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-3">
        <FieldLabel>{label}</FieldLabel>
        {used > limit * 0.7 ? (
          <Mono size="2xs" tone={used > limit ? "danger" : "faint"}>
            {used}/{limit}
          </Mono>
        ) : null}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        aria-invalid={invalid || used > limit}
        className={cn(
          "focus-ring text-body-lg mt-1.5 w-full rounded-control bg-fill-hover px-3.5 py-2.75 text-ink placeholder:text-faint",
          "aria-invalid:border aria-invalid:border-danger",
        )}
      />
      {FIELD_HELP[field] ? <p className="mt-2 text-fine text-faint">{FIELD_HELP[field]}</p> : null}
    </label>
  );
}
