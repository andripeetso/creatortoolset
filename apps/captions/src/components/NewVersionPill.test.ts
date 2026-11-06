import { expect, it } from "vitest";
import { entryOf } from "./NewVersionPill";

it("reads the built entry script from index.html", () => {
  expect(entryOf('<script>x</script><script type="module" crossorigin src="./assets/app-0jKjV6-u.js"></script>')).toBe("app-0jKjV6-u.js");
  expect(entryOf("<html></html>")).toBeNull();
});
