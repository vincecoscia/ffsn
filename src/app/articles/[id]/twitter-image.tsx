// Route segment config has to be declared here, not re-exported: Next parses it statically
// and a re-exported `revalidate` fails the build ("mustn't be reexported").
export const revalidate = 3600;
export { default, alt, size, contentType } from "./opengraph-image";
