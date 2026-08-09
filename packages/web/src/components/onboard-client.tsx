"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  GANTRY_FEE_BPS,
  PROFILE_LIMITS,
  basescanAddress,
  basescanTx,
  formatBps,
  isDeceptive,
  isValidHandle,
  normalizePayout,
  normalizeProfile,
  profileFieldLength,
  shortAddress,
  type ProfileField,
  type RegisterMerchantResponse,
} from "@gantry/shared";
import { Card, Chip, KeyValue, KeyValueList, Label, Mono } from "@/components/primitives";
import { api, ApiClientError } from "@/lib/api";
import { appUrl } from "@/lib/env";
import { cn } from "@/lib/utils";

/** Handle availability, checked live against GET /api/merchants/:handle. */
type Availability =
  | { name: "idle" }
  | { name: "invalid" }
  | { name: "checking" }
  | { name: "available" }
  | { name: "taken" }
  | { name: "unknown"; message: string };

type Step =
  | { name: "form" }
  | { name: "submitting" }
  | { name: "registered"; merchant: RegisterMerchantResponse }
  | { name: "failed"; errorName: string; message: string };

const DEBOUNCE_MS = 400;

/* The design system has no bordered controls: an input is a sunken fill on a
   white card, exactly like the shop-profile screen it will be edited on later.
   The focus ring is added here because the prototypes have none — on a form
   where a mistyped field is unrecoverable, that is not optional. */
const INPUT_CLASS =
  "focus-ring w-full rounded-control bg-fill-hover px-3.5 py-2.75 text-input text-ink " +
  "transition-colors placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60";

/* 12px faint is what the prototype uses for field labels; `quiet` instead,
   because a label at 2.9:1 against white is a decoration, not a label. */
const LABEL_CLASS = "text-meta-sm font-medium text-quiet";

const BTN_INK =
  "focus-ring inline-flex items-center justify-center rounded-control bg-ink px-4.5 py-3 " +
  "text-btn-sm text-paper transition-colors hover:bg-ink-hover " +
  "disabled:pointer-events-none disabled:bg-nav-active disabled:text-faintest";
const BTN_SUBTLE =
  "focus-ring inline-flex items-center justify-center rounded-control bg-fill-subtle px-4.5 py-3 " +
  "text-btn-sm font-medium text-quiet transition-colors hover:bg-fill-hover-strong";

/** Message copy per field, for the cases the shared normalizer names by wire key. */
const FIELD_LABEL: Record<ProfileField, string> = {
  displayName: "Shop name",
  location: "Location",
  blurb: "One line about the shop",
};

const REQUIRED_HINT: Record<ProfileField, string> = {
  displayName: "Required. This is the name on every receipt.",
  location: "Required. It sits under your name on the payer's page.",
  blurb: "Required. One line, and payers see it before they pay.",
};

/**
 * Which field to complain under, and in what words.
 *
 * The RULES are `normalizeProfile`'s and only `normalizeProfile`'s — it gates
 * submit, so this can never green-light something the API would refuse. What
 * lives here is wording: the shared messages name fields by their wire key
 * ("displayName must not be blank"), which is right for an API response and
 * wrong under an input labelled "Shop name".
 */
function profileIssue(field: ProfileField, value: string): string | null {
  const length = profileFieldLength(value);
  if (length === 0) return REQUIRED_HINT[field];
  if (length > PROFILE_LIMITS[field]) {
    return `${length - PROFILE_LIMITS[field]} characters too long.`;
  }
  if (isDeceptive(value.trim())) {
    return "One line of plain text. No line breaks, invisible or direction-flipping characters.";
  }
  return null;
}

/**
 * Shop name → a candidate handle: lowercase, non-alphanumerics collapsed to
 * hyphens, trimmed to what HANDLE_REGEX accepts.
 *
 * A suggestion, never an override — it stops the moment the merchant touches the
 * handle field. Typing the shop name is the whole handle step for most stalls,
 * and the handle is the field this form can least afford to slow down: it is a
 * URL, it goes on a printed standee, and it is claimed permanently.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/**
 * A shop's mark, derived from its handle. Logo upload is not built, and a stall
 * with no image must still look like itself on a payer's receipt.
 */
function monogram(handle: string): string {
  const parts = handle.split("-").filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0]!;
  return (first[0]! + (parts[1]?.[0] ?? first[1] ?? "")).toUpperCase();
}

/** `https://gantry.example/pay/x` → `gantry.example/pay/x`, as it prints. */
function payLinkLabel(handle: string): string {
  return `${appUrl()}/pay/${handle}`.replace(/^https?:\/\//, "");
}

export function OnboardClient() {
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [payout, setPayout] = useState("");
  const [categoryId, setCategoryId] = useState(CATEGORY_OPTIONS[0]?.id ?? 1);
  const [location, setLocation] = useState("");
  const [blurb, setBlurb] = useState("");
  // A blank field is not a mistake until the merchant has left it behind, so
  // errors under untouched fields stay silent and the button hint does the work.
  const [touched, setTouched] = useState<Partial<Record<ProfileField, boolean>>>({});
  const [availability, setAvailability] = useState<Availability>({ name: "idle" });
  const [step, setStep] = useState<Step>({ name: "form" });
  // The route's own verdict on a value we thought was fine — kept separate from
  // `step` so it corrects the form in place rather than replacing it with a card.
  const [serverIssue, setServerIssue] = useState<string | null>(null);
  // Bumping this re-runs the availability check without changing the handle —
  // otherwise one transient failure locks the form until the merchant happens
  // to edit the input, which nobody discovers live.
  const [recheck, setRecheck] = useState(0);
  const submitInFlight = useRef(false);

  useEffect(() => {
    if (handle === "") {
      setAvailability({ name: "idle" });
      return;
    }
    // The shared regex mirrors GantryCore._validateHandle, so a malformed
    // handle is rejected locally without burning a request.
    if (!isValidHandle(handle)) {
      setAvailability({ name: "invalid" });
      return;
    }

    setAvailability({ name: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .merchant(handle)
        .then(() => {
          if (!cancelled) setAvailability({ name: "taken" });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // 404 MerchantNotFound is the whole point — nobody has this handle.
          // Anything else (offline, CORS, 500) must NOT read as available, or
          // we walk the merchant into a submit that cannot succeed.
          if (err instanceof ApiClientError && err.errorName === "MerchantNotFound") {
            setAvailability({ name: "available" });
          } else {
            setAvailability({
              name: "unknown",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle, recheck]);

  // Same EIP-55 check the backend runs, so the form can't green-light an
  // address the route will reject — or worse, accept a mistyped one. getAddress
  // would not do: it re-checksums a corrupted paste instead of refusing it.
  const payoutCheck = normalizePayout(payout);
  // Same code the API validates with, so the ceilings AND the rules agree.
  const profileCheck = normalizeProfile({ displayName, location, blurb });
  const busy = step.name === "submitting";
  const canSubmit =
    step.name === "form" && availability.name === "available" && payoutCheck.ok && profileCheck.ok;

  /** Any edit invalidates whatever the route last said about these values. */
  function edited<T>(apply: (value: T) => void): (value: T) => void {
    return (value: T) => {
      setServerIssue(null);
      apply(value);
    };
  }

  /** The one thing still standing between this form and a registration. */
  function blocker(): string | null {
    if (availability.name === "idle") return "Start with your shop name. The handle follows it.";
    if (availability.name === "checking") return "Checking that handle…";
    if (availability.name !== "available") return "Pick a shop handle that is free.";
    if (!payoutCheck.ok) {
      // A malformed address already explains itself under the field; an empty
      // one says nothing at all, so it is the one that needs naming here.
      return payout === "" ? "Add the address your money lands in." : "Check the payout address.";
    }
    // Falls back to the shared message so a rule this form does not render
    // inline can never leave the button dead with nothing to explain it.
    if (!profileCheck.ok) {
      const field = profileCheck.field;
      const issue = profileIssue(field, { displayName, location, blurb }[field]);
      return `${FIELD_LABEL[field]}: ${issue ?? profileCheck.message}`;
    }
    return null;
  }

  async function submit() {
    if (!canSubmit || !payoutCheck.ok || !profileCheck.ok || submitInFlight.current) return;
    submitInFlight.current = true;
    setServerIssue(null);
    setStep({ name: "submitting" });
    try {
      const merchant = await api.registerMerchant({
        handle,
        payout: payoutCheck.address,
        categoryId,
        // Already trimmed by the shared normalizer, which the route re-runs.
        ...profileCheck.value,
      });
      setStep({ name: "registered", merchant });
    } catch (err: unknown) {
      const errorName = err instanceof ApiClientError ? err.errorName : "NetworkError";
      const message = err instanceof Error ? err.message : String(err);
      // Someone took the handle between the availability check and the tx.
      // That is a "pick another name", not a failure worth a red card. (If the
      // handle is taken by THIS payout, the backend proves it on-chain and
      // returns success instead, so reaching here means it really is someone
      // else's.)
      if (errorName === "HandleTaken") {
        setAvailability({ name: "taken" });
        setStep({ name: "form" });
      } else if (errorName === "InvalidProfile" || errorName === "InvalidPayout") {
        // Fixable in the field it came from, and nothing was sent on-chain —
        // so keep everything typed and say what to change.
        setTouched({ displayName: true, location: true, blurb: true });
        setServerIssue(message);
        setStep({ name: "form" });
      } else {
        setStep({ name: "failed", errorName, message });
      }
    } finally {
      submitInFlight.current = false;
    }
  }

  /** Returning to the form after a failure must re-check the handle: the
   * previous verdict is stale, and the attempt itself may have claimed it. */
  function backToForm(): void {
    setStep({ name: "form" });
    setAvailability({ name: "checking" });
    setRecheck((n) => n + 1);
  }

  const categoryLabel = CATEGORY_LABELS[categoryId] ?? "";

  return (
    <main className="mx-auto max-w-[1100px] px-5 py-10 sm:px-10 lg:py-14">
      {/* Once the shop exists this stops being true, and the success card carries
          its own title — a stale "Set up your shop" over a registered merchant
          reads as though the registration did not take. */}
      {step.name !== "registered" && (
        <header>
          <Label size="eyebrow">For shops</Label>
          <h1 className="mt-3 text-page-title">Set up your shop</h1>
          <p className="mt-2.5 max-w-[58ch] text-body text-quiet">
            Six fields, no account, no app to install. At the end you have a printable code for
            the counter and a live feed of every payment, whether a person scanned it or an AI
            agent paid over the same link.
          </p>
        </header>
      )}

      {(step.name === "form" || step.name === "submitting") && (
        <div className="mt-8 grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_392px]">
          <Card
            as="form"
            pad="lg"
            className="flex flex-col gap-5.5"
            onSubmit={(event: React.FormEvent) => {
              event.preventDefault();
              void submit();
            }}
          >
            <TextField
              id="display-name"
              label="Shop name"
              value={displayName}
              disabled={busy}
              limit={PROFILE_LIMITS.displayName}
              placeholder="Ah Hock Chicken Rice"
              autoComplete="organization"
              error={touched.displayName ? profileIssue("displayName", displayName) : null}
              hint="What a payer sees on the receipt and on your shop page."
              onChange={edited((value: string) => {
                setDisplayName(value);
                // The handle follows the name until the merchant takes it over.
                if (!handleEdited) setHandle(slugify(value));
              })}
              onBlur={() => setTouched((t) => ({ ...t, displayName: true }))}
            />

            <TextField
              id="handle"
              label="Shop handle"
              value={handle}
              disabled={busy}
              mono
              prefix="@"
              placeholder="ah-hock-chicken-rice"
              tag={
                <Chip size="sm" mono>
                  claimed once, forever
                </Chip>
              }
              hint={
                <AvailabilityHint
                  availability={availability}
                  handle={handle}
                  onRetry={() => {
                    setAvailability({ name: "checking" });
                    setRecheck((n) => n + 1);
                  }}
                />
              }
              onChange={edited((value: string) => {
                setHandle(value.toLowerCase());
                // Clearing the field hands the suggestion back — otherwise a
                // merchant who deletes a typo is stuck typing the whole thing.
                setHandleEdited(value.trim() !== "");
              })}
            />

            <div className="grid grid-cols-1 gap-5.5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLASS} htmlFor="category">
                  Category
                </label>
                <div className="relative">
                  <select
                    id="category"
                    className={cn(INPUT_CLASS, "appearance-none pr-9")}
                    value={categoryId}
                    disabled={busy}
                    aria-describedby="category-msg"
                    onChange={(e) => setCategoryId(Number(e.target.value))}
                  >
                    {CATEGORY_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-meta-sm text-faint"
                  >
                    ▾
                  </span>
                </div>
                <p id="category-msg" className="text-fine text-faint">
                  Agents check this against their spend policy: a food budget cannot buy
                  electronics.
                </p>
              </div>

              <TextField
                id="location"
                label="Location"
                value={location}
                disabled={busy}
                limit={PROFILE_LIMITS.location}
                placeholder="Maxwell Food Centre #01-32"
                error={touched.location ? profileIssue("location", location) : null}
                hint="Where you are, as a payer would look for you."
                onChange={edited(setLocation)}
                onBlur={() => setTouched((t) => ({ ...t, location: true }))}
              />
            </div>

            <TextField
              id="blurb"
              label="One line about the shop"
              value={blurb}
              disabled={busy}
              limit={PROFILE_LIMITS.blurb}
              placeholder="Hainanese chicken rice since 1987."
              error={touched.blurb ? profileIssue("blurb", blurb) : null}
              hint="One line, on purpose: it renders as a single line on your shop page."
              onChange={edited(setBlurb)}
              onBlur={() => setTouched((t) => ({ ...t, blurb: true }))}
            />

            <div className="flex flex-col gap-1.5 border-t border-hairline pt-5.5">
              <Label size="md" className="mb-1.5">
                Where the money goes
              </Label>
              <TextField
                id="payout"
                label="Payout address"
                value={payout}
                disabled={busy}
                mono
                placeholder="0x…"
                error={payout === "" || payoutCheck.ok ? null : payoutCheck.message}
                hint={`Every payment lands here as XSGD, minus the ${formatBps(GANTRY_FEE_BPS)} protocol fee. Only this address can ever change it. Check it against your wallet.`}
                onChange={edited((value: string) => setPayout(value.trim()))}
              />
            </div>

            <div className="flex flex-col gap-3 border-t border-hairline pt-5.5">
              <button type="submit" disabled={!canSubmit} className={cn(BTN_INK, "w-full")}>
                {busy
                  ? "Registering on-chain…"
                  : handle === ""
                    ? "Claim my handle on-chain"
                    : `Claim @${handle} on-chain`}
              </button>
              {/* Always rendered, empty or not: a live region that appears and
                  disappears is announced inconsistently, and this one carries
                  the only explanation a disabled button has. */}
              <p
                aria-live="polite"
                className={cn("text-fine", serverIssue ? "text-danger" : "text-muted")}
              >
                {serverIssue ?? blocker() ?? ""}
              </p>
              <p className="text-fine text-faint">
                A real transaction on Base Sepolia: the relayer pays its gas, so you need no ETH.
                The handle is yours permanently and cannot be renamed; the payout address can only
                ever be changed by itself.
              </p>
            </div>
          </Card>

          <PayerPreview
            displayName={displayName}
            handle={handle}
            categoryLabel={categoryLabel}
            location={location}
            blurb={blurb}
          />
        </div>
      )}

      {step.name === "registered" && <RegisteredCard merchant={step.merchant} />}

      {step.name === "failed" && (
        <Card
          radius="panel"
          pad="lg"
          className="mx-auto mt-8 flex w-full max-w-[560px] flex-col items-center gap-3 text-center"
        >
          <div
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-danger-tint text-title text-danger"
          >
            ✕
          </div>
          <Mono size="md" tone="danger">
            {step.errorName}
          </Mono>
          <p className="text-body text-quiet">{step.message}</p>
          <p className="text-fine text-muted">
            If the registration may have been sent, open{" "}
            <Link className="focus-ring underline underline-offset-2" href={`/pay/${handle}`}>
              /pay/{handle}
            </Link>{" "}
            before retrying. If it loads, you are already registered.
          </p>
          <button type="button" className={cn(BTN_SUBTLE, "mt-2")} onClick={backToForm}>
            Back to the form
          </button>
        </Card>
      )}

      <footer className="mt-10 text-meta text-faint">
        <Link className="focus-ring" href="/">
          ← Overview
        </Link>
      </footer>
    </main>
  );
}

/**
 * One labelled control.
 *
 * The hint and the error share one element, wired to the input by id: a screen
 * reader hears "taken — pick another" from the same place a sighted merchant
 * reads it, and `aria-live` means the availability verdict is announced rather
 * than silently swapped underneath a field they have already left.
 */
interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  autoComplete?: string;
  /** Identifiers (handle, address) are mono — the same rule the rest of the app follows. */
  mono?: boolean;
  /** Non-editable adornment inside the field, e.g. the handle's leading `@`. */
  prefix?: string;
  /** Rendered beside the label — the handle's permanence tag. */
  tag?: React.ReactNode;
  /** Codepoint ceiling from PROFILE_LIMITS; shows a counter as the value nears it. */
  limit?: number;
  error?: string | null;
  hint?: React.ReactNode;
  onBlur?: () => void;
}

function TextField({
  id,
  label,
  value,
  onChange,
  disabled,
  placeholder,
  autoComplete,
  mono = false,
  prefix,
  tag,
  limit,
  error,
  hint,
  onBlur,
}: TextFieldProps) {
  const messageId = `${id}-msg`;
  // Codepoints, not String.length: an emoji costs two UTF-16 units and would
  // otherwise show 58/60 on a name the API counts as 30 characters.
  const length = limit === undefined ? 0 : profileFieldLength(value);
  // A counter on an empty field is noise; a counter that appears as the ceiling
  // approaches is a warning. 20 characters out is roughly one more phrase.
  const showCounter = limit !== undefined && length > limit - 20;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className={LABEL_CLASS} htmlFor={id}>
          {label}
        </label>
        <div className="flex items-center gap-2">
          {tag}
          {showCounter && (
            <Mono size="3xs" tone={length > limit ? "danger" : "faintest"}>
              {length}/{limit}
            </Mono>
          )}
        </div>
      </div>
      <div className="relative">
        {prefix !== undefined && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 font-mono text-input text-faint"
          >
            {prefix}
          </span>
        )}
        <input
          id={id}
          type="text"
          className={cn(INPUT_CLASS, mono && "font-mono", prefix !== undefined && "pl-8")}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      </div>
      <p
        id={messageId}
        aria-live="polite"
        className={cn("text-fine", error ? "text-danger" : "text-faint")}
      >
        {error ?? hint}
      </p>
    </div>
  );
}

function AvailabilityHint({
  availability,
  handle,
  onRetry,
}: {
  availability: Availability;
  handle: string;
  onRetry: () => void;
}) {
  switch (availability.name) {
    case "idle":
      return (
        <>
          Lowercase letters, numbers and hyphens. It becomes your pay link. The first shop to take
          it claims it on-chain, permanently.
        </>
      );
    case "invalid":
      return <>Use 1–32 characters of a–z, 0–9 or -, not starting or ending with a hyphen.</>;
    case "checking":
      return <>Checking…</>;
    case "available":
      return (
        <span className="text-accent">
          Free. Your pay link will be <Mono size="3xs">{payLinkLabel(handle)}</Mono>
        </span>
      );
    case "taken":
      return (
        <span className="text-danger">
          {handle} is taken. Pick another. Handles are claimed once, permanently.
        </span>
      );
    case "unknown":
      // Without a way back this state is terminal — the effect only re-runs
      // when the handle string changes, so one blip would otherwise disable
      // registration until the merchant happened to retype the name.
      return (
        <span className="text-danger">
          Couldn&apos;t check that handle: {availability.message}{" "}
          <button type="button" className="focus-ring underline underline-offset-2" onClick={onRetry}>
            try again
          </button>
        </span>
      );
  }
}

/**
 * The same card the payer app renders for a merchant, built from what has been
 * typed so far.
 *
 * It earns its place by making three otherwise-abstract fields concrete: a name,
 * a location and a blurb are hard to take seriously as form fields and obvious
 * as a shop page. It claims nothing the chain does not yet know — the handle is
 * marked unregistered until it actually is.
 */
function PayerPreview({
  displayName,
  handle,
  categoryLabel,
  location,
  blurb,
}: {
  displayName: string;
  handle: string;
  categoryLabel: string;
  location: string;
  blurb: string;
}) {
  const name = displayName.trim();
  const where = location.trim();
  const line = blurb.trim();
  const mark = monogram(handle);

  return (
    <Card tone="sunken" pad="none" className="p-5.5">
      <Label>What a payer sees</Label>
      <Card radius="control-m" pad="none" className="mt-3.5 p-5.5">
        <div className="flex items-center gap-3.5">
          <div
            aria-hidden
            className={cn(
              "flex size-13 shrink-0 items-center justify-center rounded-tile font-mono text-mono",
              mark === "" ? "stripe-placeholder" : "bg-accent-tint text-accent",
            )}
          >
            {mark}
          </div>
          <div className="min-w-0">
            <div className={cn("truncate text-card-title", name === "" && "text-faint")}>
              {name === "" ? "Your shop's name" : name}
            </div>
            <div className={cn("mt-0.75 truncate text-meta-sm", where === "" ? "text-faint" : "text-muted")}>
              {where === "" ? "Where you are" : where}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Chip tone="accent">{categoryLabel}</Chip>
        </div>

        <p
          className={cn(
            "mt-4 border-t border-fill-subtle pt-4 text-meta",
            line === "" ? "text-faint" : "text-muted",
          )}
        >
          {line === "" ? "One line about the shop." : line}
        </p>

        <Mono size="3xs" tone="faintest" className="mt-3.5 block">
          {handle === "" ? "@your-handle" : `@${handle}`} · not registered yet
        </Mono>
      </Card>
      <p className="mt-3.5 text-fine text-muted">
        Payers open this from a receipt. Once you claim the handle it also carries “Registered
        on-chain” and the date. It never shows your balance or your payouts.
      </p>
    </Card>
  );
}

function RegisteredCard({ merchant }: { merchant: RegisterMerchantResponse }) {
  const name = merchant.displayName ?? merchant.handle;
  const category = CATEGORY_LABELS[merchant.categoryId] ?? merchant.categoryName;

  return (
    <Card
      radius="panel"
      pad="lg"
      role="status"
      className="mx-auto mt-8 flex w-full max-w-[560px] flex-col items-center gap-4 text-center"
    >
      <div
        aria-hidden
        className="flex size-13 items-center justify-center rounded-full bg-accent text-title-lg text-on-accent"
      >
        ✓
      </div>
      <div>
        <h1 className="text-page-title">{name}</h1>
        <Mono size="sm" tone="muted" className="mt-1.5 block">
          @{merchant.handle}
        </Mono>
      </div>

      <div className="flex flex-wrap justify-center gap-1.5">
        <Chip tone="accent">{category}</Chip>
        {/* Neutral, not a badge of approval: registration is permissionless and
            self-attested — nobody checked who this is. */}
        <Chip>Registered on-chain</Chip>
      </div>

      <KeyValueList className="w-full text-left">
        <KeyValue label="Pay link">{payLinkLabel(merchant.handle)}</KeyValue>
        <KeyValue label="Payout">
          <a
            className="focus-ring"
            href={basescanAddress(merchant.payout)}
            target="_blank"
            rel="noreferrer"
          >
            {shortAddress(merchant.payout)} ↗
          </a>
        </KeyValue>
        {merchant.txHash ? (
          <KeyValue label="Registration" divider={false}>
            <a
              className="focus-ring"
              href={basescanTx(merchant.txHash)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(merchant.txHash)} ↗
            </a>
          </KeyValue>
        ) : null}
      </KeyValueList>

      {merchant.txHash === null && (
        // alreadyRegistered: an earlier attempt landed (lost response or receipt
        // timeout) and the chain says this payout owns the handle. It's theirs —
        // say so, and do not show a transaction that this attempt did not send.
        <Card tone="fill" radius="tile" pad="none" className="w-full p-4 text-left">
          <p className="text-meta text-quiet">
            This handle was already registered to your payout address: an earlier attempt went
            through, and this one sent nothing.
          </p>
        </Card>
      )}

      <div className="mt-2 flex w-full flex-col gap-2">
        <Link href={`/merchant/${merchant.handle}/settlements`} className={cn(BTN_INK, "w-full")}>
          Open your shop →
        </Link>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Link href={`/qr/${merchant.handle}`} className={BTN_SUBTLE}>
            Print the standee
          </Link>
          <Link href={`/pay/${merchant.handle}`} className={BTN_SUBTLE}>
            See the payer page
          </Link>
        </div>
      </div>
    </Card>
  );
}
