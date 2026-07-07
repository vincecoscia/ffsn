import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

// Mounts the Better Auth HTTP routes (sign-in, sign-up, OAuth callbacks, JWKS,
// etc.) on the Convex deployment's HTTP endpoint.
authComponent.registerRoutes(http, createAuth);

export default http;
