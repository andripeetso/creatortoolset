import { findUser, type UserRecord } from "../users";

/**
 * View-as (hosted mode): an admin reads the app as another account, read-only. The admin's login sets this cookie
 * (admin.ts POST /api/admin/view-as/:username); boot.ts answers the app's requests as that account while the
 * cookie is there, and refuses writes. Only a platform admin's own request is ever read this way.
 */
export const VIEW_AS = "ct_view_as";

/** The account an admin is reading as, from the request's cookies; null when there is none or it no longer exists. */
export function viewAsTarget(cookieHeader: string | undefined): UserRecord | null {
  const m = new RegExp(`(?:^|;\\s*)${VIEW_AS}=([a-z0-9_-]{2,24})(?:;|$)`).exec(cookieHeader ?? "");
  return m ? findUser(m[1]) : null;
}
