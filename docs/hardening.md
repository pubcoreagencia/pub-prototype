# Production Hardening Status

## Provider timeout
REAL CANCELLATION + STATE FENCING
- Network Cancellation: Active (AbortController signal passed down to HTTP/fetch requests in OpenRouter, DualGateway, and Router providers)
- State Fencing: Active (worker timeout race unblocks execution, enforces canonical TIMED_OUT error, releases task lease, closes OperationalEventBridge, and discards any subsequent late results or events)

## Workspace isolation
DOCUMENTED LIMITATION
- Previews execute within the container workspace under the node runtime without multi-tenant UID kernel sandboxing.

## Preview outbound egress
DOCUMENTED LIMITATION
- Egress network traffic from preview processes is not constrained by egress packet filtering in this single-container setup.
