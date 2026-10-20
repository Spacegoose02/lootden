/** Your logos from brand/, filled in at build time (see packages/web/brand.ts). */
declare const __BRAND__: {
  logo: string | null;
  wordmark: string | null;
  /** The big picture on the sign-in page. Missing in older builds. */
  mascot?: string | null;
  /** The logo (and favicon) is the stock raccoon, so it's drawn in the theme's colours. Missing in older builds. */
  raccoon?: boolean;
  raccoonFavicon?: boolean;
};
