/**
 * The Media Library's extension slots: who may see an asset
 * (LibraryPolicy), where assets come from (LibrarySource), and the sidebar filters and item badges a plug-in adds.
 * Types only. The registry and the default owner-only policy are in api/library/sources.ts.
 */
import type { AssetCard } from "./library";

/** Who is asking. `owner` is the account the library belongs to; `member` is someone granted in (never by default). */
export interface LibraryViewer {
  username: string;
  role: "owner" | "member";
}

/** The asset a policy is asked about: the source that holds it, its library, the asset and its current version. */
export interface LibraryAssetRef {
  sourceId: string;
  libraryId: string;
  assetId: string;
  versionId: string;
  /** Set for an external ref (api/library/refs.ts): an item of a source, with no version here. assetId is then the ref's id. */
  external?: { refId: string; kind: string; externalId: string };
}

/**
 * Decides whether a viewer may see one asset of one source. Every read path asks it (list, get, stream and thumb,
 * search, share, Finals pieces). Policies only narrow: an asset is seen when every policy of its source says yes, so
 * a plug-in can add a second gate but never open one the built-in policy closed. A source with no policy is refused.
 */
export interface LibraryPolicy {
  sourceId: string;
  canSee(viewer: LibraryViewer, asset: LibraryAssetRef): boolean | Promise<boolean>;
}

/**
 * Where assets come from. `list` and `stream` are optional: a source that only holds refs (none yet) needs neither.
 * A source's items are external refs (api/library/refs.ts): each card's id is the ref's public id, and the route
 * asks canSee before a card is sent or a byte is served. `req` is the viewer's own request, so the source can forward
 * the viewer's login (never a machine token). Errors in a source list nothing; they never widen what is seen.
 */
export interface LibrarySource {
  id: string;
  label: string;
  /** The source's cards for this viewer (the Media Library's Source picker). Ids are external ref ids. */
  list?(viewer: LibraryViewer, req: Request): Promise<AssetCard[]>;
  /** One item's bytes for a ref of this source: `thumb`, `play` or `source`. Null when there is nothing to serve. */
  stream?(viewer: LibraryViewer, req: Request, externalId: string, kind: "thumb" | "play" | "source"): Promise<Response | null>;
}

/**
 * A sidebar filter the server applies: for the values a viewer picked (`f.<key>=a,b` in the query string), `where`
 * gives the SQL over `assets a` that keeps the matching rows. The browser draws the choices from its own half
 * (LibraryWebSlot). Keys must be unique across plug-ins.
 */
export interface LibraryFacet {
  key: string;
  where: (values: string[]) => { sql: string; params: (string | number)[] };
}

/** The server half of a plug-in's `library` slot (ServerPlugin.library). */
export interface LibrarySlot {
  source?: LibrarySource;
  policies?: LibraryPolicy[];
  facets?: LibraryFacet[];
}

/** Where a facet's sidebar group shows: the Media Library, Finals, or both. */
export type LibraryFacetScope = "library" | "finals" | "both";

/** The browser half of a plug-in's `library` slot (WebPlugin.library): the choices for each facet, and badges for a card. */
export interface LibraryWebSlot {
  /** `scope` defaults to "library": a facet shows on the Media Library page only, unless it says "finals" or "both". */
  facets?: { key: string; label: string; values: { value: string; label: string }[]; scope?: LibraryFacetScope }[];
  badges?: (card: AssetCard) => { label: string }[];
}
