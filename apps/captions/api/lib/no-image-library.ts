/**
 * Stands in for the image library in the server bundle (package.json "build", --alias:sharp). The speech library
 * loads it for image models, which the server never runs, and its native files are not shipped with the server.
 */
export default function noImageLibrary(): never {
  throw new Error("The server has no image library");
}
