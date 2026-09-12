import { NextResponse } from "next/server";
import { isProduction } from "@/lib/config/env";

/**
 * Error taxonomy for route handlers.
 *
 * Before this existed, every catch block returned `error.message` with status
 * 500. That had three problems: a stale-revision conflict looked like a server
 * crash to the client, upstream failures echoed Quran Foundation response
 * bodies and internal paths to the browser, and the hint route had to sniff
 * error text with a regex to recover the right status code.
 *
 * An AppError carries its own status and a message that is safe to show. Any
 * other thrown value is treated as unexpected: it is logged in full and
 * reported to the client as a generic failure in production.
 */

export type ErrorKind =
  | "bad_request"
  | "unauthorized"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "upstream"
  | "unavailable"
  | "internal";

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  upstream: 502,
  unavailable: 503,
};

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  /** Extra fields merged into the JSON body, e.g. retryAfter. */
  readonly details?: Record<string, unknown>;
  /** Context for the server log only. Never serialized to the client. */
  readonly context?: Record<string, unknown>;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { details?: Record<string, unknown>; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.kind = kind;
    this.status = STATUS_BY_KIND[kind];
    this.details = options.details;
    this.context = options.context;
  }
}

export const badRequest = (message: string, options?: ConstructorParameters<typeof AppError>[2]) =>
  new AppError("bad_request", message, options);

export const conflict = (message: string, options?: ConstructorParameters<typeof AppError>[2]) =>
  new AppError("conflict", message, options);

export const notFound = (message: string, options?: ConstructorParameters<typeof AppError>[2]) =>
  new AppError("not_found", message, options);

export const rateLimited = (message: string, retryAfterSeconds: number) =>
  new AppError("rate_limited", message, { details: { retryAfter: retryAfterSeconds } });

export const upstreamError = (message: string, options?: ConstructorParameters<typeof AppError>[2]) =>
  new AppError("upstream", message, options);

export const unavailable = (message: string, options?: ConstructorParameters<typeof AppError>[2]) =>
  new AppError("unavailable", message, options);

/**
 * A configuration problem is an operator error, not a player error. The message
 * stays verbatim in every environment because the setup screen renders it as
 * instructions, and it never contains player data or upstream response bodies.
 */
export function isConfigurationError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /missing (qf_|round_token)|qf_env must be|round_token_secret is too short|no shared attempt store|qf_mock cannot be enabled/i.test(
    error.message,
  );
}

export type ApiErrorBody = {
  error: string;
  kind: ErrorKind;
  requestId?: string;
  [key: string]: unknown;
};

const KNOWN_KINDS = new Set<string>(Object.keys(STATUS_BY_KIND));

/**
 * Recognise a domain error by shape rather than by class.
 *
 * The game rules, the attempt record, and the round token deliberately do not
 * import anything from `next` — that is what keeps them unit-testable and
 * reusable outside a request. They still need to say "this is a 409, not a
 * crash", so they expose a `kind` string and this layer reads it structurally.
 * The dependency points one way: HTTP knows about the domain, never the
 * reverse.
 */
function asDomainError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (!(error instanceof Error)) return null;
  const kind = (error as Error & { kind?: unknown }).kind;
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) return null;
  return new AppError(kind as ErrorKind, error.message, { cause: error });
}

let requestCounter = 0;

function newRequestId() {
  requestCounter = (requestCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

/**
 * Convert anything thrown inside a route handler into a JSON response.
 *
 * In production, unexpected errors collapse to a generic message plus a request
 * id, and the real error goes to the server log under that id. In development
 * the message is passed through, because a developer staring at a broken round
 * needs the upstream status code, not a correlation id.
 */
export function toErrorResponse(error: unknown, route: string) {
  const requestId = newRequestId();
  const appError = asDomainError(error);

  if (appError) {
    const error = appError;
    if (error.status >= 500) {
      console.error(`[${route}] ${error.kind} ${requestId}`, {
        message: error.message,
        ...error.context,
        cause: error.cause,
      });
    }
    const body: ApiErrorBody = { error: error.message, kind: error.kind, ...(error.details ?? {}) };
    if (error.status >= 500) body.requestId = requestId;
    const response = NextResponse.json(body, { status: error.status });
    if (error.kind === "rate_limited" && typeof error.details?.retryAfter === "number") {
      response.headers.set("Retry-After", String(error.details.retryAfter));
    }
    return response;
  }

  if (isConfigurationError(error)) {
    console.error(`[${route}] configuration ${requestId}`, error);
    return NextResponse.json(
      { error: (error as Error).message, kind: "internal", requestId } satisfies ApiErrorBody,
      { status: 500 },
    );
  }

  console.error(`[${route}] unexpected ${requestId}`, error);
  const message = isProduction()
    ? "Something went wrong on our side. Please try again."
    : error instanceof Error
      ? error.message
      : String(error);
  return NextResponse.json({ error: message, kind: "internal", requestId } satisfies ApiErrorBody, { status: 500 });
}
