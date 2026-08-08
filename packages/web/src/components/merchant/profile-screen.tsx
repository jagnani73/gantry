"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CATEGORY_LABELS,
  PROFILE_LIMITS,
  normalizeProfile,
  profileFieldLength,
  shortAddress,
  type MerchantProfile,
  type ProfileField,
} from "@gantry/shared";
import { Card, Chip, Label, Mono } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, ApiClientError } from "@/lib/api";
import { shortDate } from "./format";
import { useMerchantContext } from "./merchant-context";
import { ScreenHeader } from "./screen-header";
import { ShopTile } from "./shop-tile";

/**
 * The shop's public identity.
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

const FIELD_HELP: Partial<Record<ProfileField, string>> = {
  blurb: "One line. It appears on the payer's view of your shop.",
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string; field?: ProfileField };

export function ProfileScreen() {
  const { handle, merchant, replace } = useMerchantContext();

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
      setSave({ kind: "saved" });
    } catch (err) {
      // The API's messages are written for a person to read (the disabled-host
      // one explains why it is off), so they are surfaced verbatim.
      setSave({
        kind: "error",
        message: err instanceof ApiClientError || err instanceof Error ? err.message : String(err),
      });
    }
  }

  const preview: MerchantProfile = {
    displayName: draft.displayName.trim() || handle,
    location: draft.location.trim(),
    blurb: draft.blurb.trim(),
  };

  return (
    <>
      <ScreenHeader title="Shop profile">
        Your public identity — what a payer sees before they hand over money.
      </ScreenHeader>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1fr_392px]">
        <Card as="form" radius="card" pad="lg" onSubmit={submit} className="flex flex-col gap-5.5">
          <div className="flex flex-wrap items-start gap-5">
            <ShopTile name={preview.displayName} size="lg" />
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Category</FieldLabel>
              <div className="mt-1.5 flex items-center justify-between gap-3 rounded-control bg-fill-subtle px-3.5 py-2.75">
                <span className="text-body-lg text-muted">
                  {merchant === null
                    ? "—"
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
          {save.kind === "saved" ? (
            <p role="status" className="text-meta text-accent">
              Saved. Every payer surface reads this record.
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
            {merchant ? (
              <Mono size="3xs" tone="faintest" className="mt-3.5 block">
                merchant {shortAddress(merchant.merchantId)}
                {merchant.registeredAt === undefined
                  ? null
                  : ` · registered ${shortDate(merchant.registeredAt)}`}
              </Mono>
            ) : null}
          </Card>
          <p className="mt-3.5 text-fine text-quiet">
            Payers reach this from a receipt or from a shop they have paid before. It carries
            nothing about your balance or your payouts.
          </p>
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
          // `text-body-lg`, not `text-input`: `input` is a legacy shadcn colour
          // alias, so cn classifies `text-input` as a colour and drops the size.
          "focus-ring text-body-lg mt-1.5 w-full rounded-control bg-fill-hover px-3.5 py-2.75 text-ink placeholder:text-faint",
          "aria-invalid:border aria-invalid:border-danger",
        )}
      />
      {FIELD_HELP[field] ? <p className="mt-2 text-fine text-faint">{FIELD_HELP[field]}</p> : null}
    </label>
  );
}
