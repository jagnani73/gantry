"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CATEGORY_OPTIONS,
  categoryParam,
  directoryHaystack,
  isIndexBehind,
  matchesDirectory,
  resolveCategoryFilter,
  resolveDirectoryQuery,
  resolveShopParam,
  type MerchantSummary,
} from "@gantry/shared";
import { Card, Label, Mono } from "@/components/primitives";
import { GUTTER_X } from "@/components/landing/content";
import { grouped, plural } from "@/components/merchant/format";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DirectoryFooter, DirectoryHeader } from "./directory-chrome";
import { MerchantCard } from "./merchant-card";
import { MerchantDrawer } from "./merchant-drawer";

type Status = "loading" | "ready" | "error";

interface IndexState {
  status: Status;
  merchants: MerchantSummary[];
  /** The census as the index counts it. */
  total: number;
  /** Blocks this host is behind the chain head; null before any head is read.
   * Decides whether the page may say a shop is NOT registered. */
  lag: number | null;
  error: string | null;
}

const INITIAL: IndexState = {
  status: "loading",
  merchants: [],
  total: 0,
  lag: null,
  error: null,
};

/**
 * The public merchant directory.
 *
 * Fetched CLIENT-side, like the merchant back-office and for the same reason: the
 * public backend is a free-tier instance that spins down when idle, so a
 * server-side fetch would turn a ~50s cold start into a blank render of the whole
 * page. A loading state is honest about the wait; a stalled server render is not.
 *
 * All three pieces of state live in the URL, so a filtered listing and an
 * individual shop are both linkable and survive a refresh.
 *
 * The page makes exactly two claims about the chain — "no shop matches that" and
 * a count under "Registered" — and both are gated on `isIndexBehind`, because a
 * host mid-backfill holds a fraction of the rail and would otherwise assert the
 * rail is empty. That is the same instinct as the error card below: say what is
 * actually known, never let a failure render as a fact.
 */
export function MerchantDirectory() {
  const [index, setIndex] = useState<IndexState>(INITIAL);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIndex((prev) => ({ ...prev, status: "loading", error: null }));
    api
      .merchants()
      .then((res) => {
        if (cancelled) return;
        setIndex({
          status: "ready",
          merchants: res.merchants,
          total: res.total,
          lag: res.indexer.lag,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setIndex({
          status: "error",
          merchants: [],
          total: 0,
          lag: null,
          error: err instanceof ApiClientError || err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const pathname = usePathname();
  const params = useSearchParams();

  /**
   * Builds the next URL from `window.location.search` rather than from a closed
   * over `params`, so a pending write can never resurrect a value changed while
   * it was in flight, and so every writer below stays a stable callback.
   */
  const url = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(window.location.search);
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      const search = next.toString();
      return search === "" ? pathname : `${pathname}?${search}`;
    },
    [pathname],
  );

  /*
   * All three URL-backed values are LOCAL STATE, seeded from the URL once, and
   * the URL is kept in step with the History API rather than the router.
   *
   * The reason is what these three ARE, not how fast the router is: which drawer
   * is open, which category is selected and what was typed are decisions this
   * component has already made, over a list it already holds in memory. Routing
   * them makes a server round-trip the gate on rendering state the client
   * authored — and the search box proved what that costs, since a `router.replace`
   * per debounced keystroke left the address bar several searches stale, which is
   * worse than no URL sync because the stale URL is the one that gets copied.
   * `pushState` is synchronous and cannot fall behind. (Do not repeat the
   * measurement mistake made here first: a background tab clamps `setTimeout` to
   * 1s, so timer-polled UI latency reads as ~1000ms whatever the truth is. Use a
   * MutationObserver.)
   *
   * The URL still does its whole job: seeded on mount, so `?q=&category=&shop=`
   * survive a refresh and a shared link, and `popstate` below hands authority
   * back to the URL on Back and Forward — which is what keeps Back a way out of
   * the drawer rather than a way back into it.
   *
   * The one thing this gives up: a `<Link>` elsewhere in the app pointing at
   * `/merchants?shop=…` would change the URL without re-seeding this state, so
   * the drawer would not open. Nothing links here that way today (the landing
   * header points at the bare route), and a link that needs to would have to
   * force a remount or this would have to listen for it.
   */
  const [text, setText] = useState(() => params.get("q") ?? "");
  const [categoryId, setCategoryId] = useState(() => resolveCategoryFilter(params.get("category")));
  const [openHandle, setOpenHandle] = useState(() => resolveShopParam(params.get("shop")));

  useEffect(() => {
    const onPop = () => {
      const current = new URLSearchParams(window.location.search);
      setText(current.get("q") ?? "");
      setCategoryId(resolveCategoryFilter(current.get("category")));
      setOpenHandle(resolveShopParam(current.get("shop")));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The typed text trails into the URL on a debounce, and `replace` rather than
  // `push`: a history entry per keystroke would make Back useless for the
  // gesture it is most needed for, closing the drawer.
  useEffect(() => {
    const id = setTimeout(() => {
      window.history.replaceState(null, "", url("q", text.trim()));
    }, 250);
    return () => clearTimeout(id);
  }, [text, url]);

  const selectCategory = useCallback(
    (id: number | null) => {
      setCategoryId(id);
      window.history.pushState(null, "", url("category", categoryParam(id)));
    },
    [url],
  );

  const openShop = useCallback(
    (handle: string) => {
      setOpenHandle(handle);
      window.history.pushState(null, "", url("shop", handle));
    },
    [url],
  );

  /**
   * PUSH to open, REPLACE to close. Opening a shop is a step forward that Back
   * should undo; closing is that undo, so pushing it too would leave the open
   * drawer one step behind and Back would re-open it rather than leave the page.
   * Replacing collapses the two into one entry, so Back from a closed drawer
   * goes wherever the reader was before they opened it.
   *
   * `history.back()` would also work and is tempting, but it walks off the site
   * when the drawer came from a deep link with no entry of ours to pop.
   */
  const closeDrawer = useCallback(() => {
    setOpenHandle(null);
    window.history.replaceState(null, "", url("shop", null));
  }, [url]);

  const entries = useMemo(
    () =>
      index.merchants.map((merchant) => ({
        merchant,
        haystack: directoryHaystack(merchant),
        categoryId: merchant.categoryId,
      })),
    [index.merchants],
  );

  const query = resolveDirectoryQuery(text);
  const visible = useMemo(
    () => entries.filter((entry) => matchesDirectory(entry, { query, categoryId })),
    [entries, query, categoryId],
  );

  const open = index.merchants.find((m) => m.handle === openHandle) ?? null;
  const categoryCount = new Set(index.merchants.map((m) => m.categoryId)).size;
  const filtered = query !== "" || categoryId !== null;
  const capped = index.status === "ready" && index.total > index.merchants.length;
  // This host is too far back to be quoted. Everything the page states as fact
  // about the rail is gated on it — see the component docblock.
  const behind = index.status === "ready" && isIndexBehind(index.lag);
  const settled = index.status === "ready" && !behind;

  return (
    <main className="mx-auto flex min-h-dvh max-w-[1440px] flex-col">
      <DirectoryHeader />

      <section
        className={cn(
          "grid gap-x-18 gap-y-10 pt-12 pb-10 min-[1100px]:grid-cols-[1fr_392px] min-[1100px]:items-end lg:pt-17",
          GUTTER_X,
        )}
      >
        <div>
          {/* 32 → 40 → 56. Every step is a `min-[…]` variant, including the two
              that have named equivalents: Tailwind sorts named breakpoints and
              arbitrary ones into separate blocks, so `sm:text-figure-sm` beat
              `min-[1100px]:text-hero-sm` at every width and the headline never
              reached its largest step. Mixing the two forms on ONE property is
              the bug; keeping them consistent is the fix. */}
          <h1 className="text-section max-w-[18ch] min-[640px]:text-figure-sm min-[1100px]:text-hero-sm">
            Every shop on the rail.
          </h1>
          <p className="mt-5.5 max-w-[56ch] text-body-lg text-quiet min-[1100px]:text-standfirst-sm">
            Each merchant here claimed a handle on-chain and set the address its money goes to.
            Nobody can change either but them: not another merchant, not Gantry.
          </p>
        </div>

        {/* Two figures, both derived and neither a constant — and they are NOT
            derived from the same thing: `Registered` is the index's own census,
            while `Categories` counts what was loaded. They only agree while the
            list is whole, which is why both go to "…" until the index has
            settled: a count printed under "Registered" is a claim about the
            chain, and a host mid-backfill cannot make it.

            The third is not a count at all. An "accepts agents" tally would
            equal the first, since every registered merchant takes both doors. */}
        <div className="flex flex-wrap gap-y-6">
          <Stat label="Registered" value={settled ? grouped(index.total) : "…"} />
          <Stat label="Categories" value={settled ? grouped(categoryCount) : "…"} />
          {/* MockXSGD is the one mocked token in the system and is labelled
              wherever it appears — the landing page this directory is reached
              from says so in as many words. The note goes under the figure
              rather than in it, so the caveat is not something the 30px line has
              to carry. */}
          <Stat label="Settles in" value="XSGD" tone="accent" note="testnet mock" />
        </div>
      </section>

      <section className={cn("flex flex-col gap-3 pb-7 min-[1100px]:flex-row", GUTTER_X)}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-nav bg-surface px-4">
          {/* An outlined circle, not an icon: this design uses text, dots and
              squares throughout and introduces no icon set. */}
          <span
            aria-hidden
            className="size-2.75 shrink-0 rounded-full border-[1.5px] border-faintest"
          />
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search by shop name, handle or location"
            aria-label="Search the merchant directory"
            className="focus-ring min-w-0 flex-1 rounded-badge bg-transparent py-3 text-body text-ink placeholder:text-faintest"
          />
        </div>
        {/* Scrolls horizontally rather than wrapping below 1100, with All pinned
            first. The segments also grow a taller tap target on a phone — a 44px
            target is not a smaller font. */}
        <div
          role="group"
          aria-label="Category"
          className="scrollbar-hidden flex gap-1.5 overflow-x-auto rounded-nav bg-surface p-1"
        >
          <Segment
            label="All"
            active={categoryId === null}
            onClick={() => selectCategory(null)}
          />
          {CATEGORY_OPTIONS.map((option) => (
            <Segment
              key={option.id}
              label={option.label}
              active={categoryId === option.id}
              onClick={() => selectCategory(option.id)}
            />
          ))}
        </div>
      </section>

      <section className={cn("grow pb-22", GUTTER_X)}>
        {index.status === "loading" ? (
          <Card radius="card-m" pad="lg" className="text-body text-muted">
            Reading the merchant registry from the chain…
          </Card>
        ) : index.status === "error" ? (
          <Card radius="card-m" pad="lg" className="max-w-xl">
            <h2 className="text-title-lg">Can&apos;t reach the backend</h2>
            <p className="mt-2.5 text-body text-quiet">
              The directory is built from GantryCore&apos;s own registration logs, read through the
              Gantry API, and that request did not come back. Nothing is wrong with the shops. They
              are registered on-chain whether or not this page can list them.
            </p>
            {index.error ? (
              <p className="mt-3 font-mono text-mono-sm break-all text-faint">{index.error}</p>
            ) : null}
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              className="focus-ring mt-5 rounded-control bg-ink px-4.5 py-2.5 text-btn-sm text-paper transition-colors hover:bg-ink-hover"
            >
              Try again
            </button>
          </Card>
        ) : visible.length === 0 ? (
          /*
           * Three empty states, not one, because they are three different facts.
           * Only the middle one is a claim about the CHAIN, and it is the only
           * one gated on the index having caught up — "a name that isn't here
           * has not been registered" is exactly the sentence a host mid-backfill
           * must not print.
           */
          <Card radius="card-m" pad="none" className="px-6 py-18 text-center">
            <div aria-hidden className="mx-auto size-11 rounded-tile bg-fill-subtle" />
            <h2 className="mt-4.5 text-card-title-sm">
              {behind
                ? "Still reading the registry"
                : filtered
                  ? "No shop matches that"
                  : "No shops registered yet"}
            </h2>
            <p className="mx-auto mt-2 max-w-[42ch] text-body-sm text-muted">
              {behind
                ? "This server is still catching up with the chain, so the directory is incomplete. Nothing is wrong with the shops: they are registered on-chain whether or not this page has read them yet."
                : filtered
                  ? "Handles are claimed first-come and never recycled, so a name that isn't here has not been registered."
                  : "Every merchant that registers on GantryCore is listed here, oldest first. The index fills in as the chain is swept."}
            </p>
          </Card>
        ) : (
          <>
            {/* Both steps as `min-[…]`, for the reason the headline documents. */}
            <div className="grid grid-cols-1 gap-4 min-[768px]:grid-cols-2 min-[1240px]:grid-cols-3">
              {visible.map(({ merchant }) => (
                <MerchantCard
                  key={merchant.handle}
                  merchant={merchant}
                  onOpen={() => openShop(merchant.handle)}
                />
              ))}
            </div>
            {/* No silent partial lists, from either cause: the response cap, and
                the far commoner one on this rail — a host that has not finished
                reading the chain. A list short for the second reason has `total`
                short too, so the cap check alone would call it whole. */}
            {behind ? (
              <p className="mt-5 text-meta text-faint">
                This server is still catching up with the chain, so more shops may be registered
                than are listed here.
              </p>
            ) : capped ? (
              <p className="mt-5 text-meta text-faint">
                Showing the first {plural(index.merchants.length, "shop")} of {grouped(index.total)}.
                Search and filters run over what is loaded.
              </p>
            ) : null}
          </>
        )}
      </section>

      <DirectoryFooter />

      <MerchantDrawer merchant={open} onClose={closeDrawer} />
    </main>
  );
}

/** One cell of the rail. The rules between cells come from `border-l` plus
 * `first:`, so the outer edges stay flush with the headline column above them
 * however many cells there are. */
function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: "accent";
  /** A caveat the figure itself must not have to carry. */
  note?: string;
}) {
  return (
    <div className="border-l border-hairline-strong px-8 first:border-l-0 first:pl-0 last:pr-0">
      <Label size="wide" className="tracking-[0.1em]">
        {label}
      </Label>
      {/* Steps down on a phone, where 30px beside a 32px headline is not a
          hierarchy. It is the one figure on the page that scales. */}
      <Mono size="figure" tone={tone ?? "inherit"} className="mt-2 block max-sm:text-stat">
        {value}
      </Mono>
      {note ? <div className="mt-1 text-fine text-faint">{note}</div> : null}
    </div>
  );
}

function Segment({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // 44px tall on a phone, 37 from `md` up. The floor is a minimum height
        // rather than more padding on a smaller font: below 768 every target has
        // to clear 44, and shrinking the label to buy the room is the move that
        // makes a control both harder to read and harder to hit.
        "focus-ring min-h-11 shrink-0 rounded-chip-sm px-3.5 py-2.75 text-meta whitespace-nowrap transition-colors md:min-h-0 md:py-1.75",
        active ? "bg-fill-subtle font-medium text-ink" : "text-muted hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}
