import releases from "./releases.json";

export type Release = {
  version: string;
  date: string;
  notes: string[];
};

/** All releases, newest first. Add a new entry at the TOP for each release —
 *  the build writes the newest one into dist/version.json, and running tabs
 *  compare it against CURRENT_VERSION to prompt an update. */
export const RELEASES: Release[] = releases as Release[];

export const CURRENT_RELEASE: Release = RELEASES[0];

/** The human version this bundle was built from (e.g. "1.0.0"). */
export const CURRENT_VERSION: string = CURRENT_RELEASE.version;
