# Network security and internet hosting

## The decision: a self-hostable reverse relay

Friends join from a browser, workers call an HTTP API, Git uses smart HTTP, and live updates are server-sent events. So what needs to cross the internet is HTTP, and browsers are clients.

| Option | Fit | Verdict |
|---|---|---|
| **WebRTC with STUN and TURN** | Node has no built-in WebRTC, so it would add a native dependency to a project with none. A browser cannot open a page over a data channel without first loading it from somewhere, and Git's HTTP client cannot use one at all. TURN is needed anyway on hard networks | Rejected: it would mean rewriting every transport |
| **Iroh or other QUIC libraries** | Excellent for native peers, but native code, and browsers cannot join directly | Rejected: friends would have to install something to join |
| **Reverse tunnel, as e4mc does** | The host dials out, so NAT and CGNAT do not matter, and everything stays plain HTTP | **Chosen** |
| **Someone else's tunnel** (Cloudflare, ngrok, Tailscale Funnel) | Works, and still a fine choice in Advanced. Each needs an account, a separate install or both, and terms vary. Their free tiers are not promised here | Not the built-in path |

**The cost of this choice:** connections are always relayed, never direct, so there is no NAT hole-punching. On the same network, people use the direct LAN address instead. "Direct connection" in the app means exactly that, and is only shown for it.

## What you need, and what it costs

**There is no free public relay. Somebody has to run one.** It is one small program with no dependencies.

| Setup | Needs | Rough cost |
|---|---|---|
| One office | A small server with a domain name and HTTPS | A small VPS: typically a few dollars a month. A domain: typically around $10–15 a year |
| Several offices | The same, plus a wildcard DNS record and wildcard certificate | The same |

Prices are typical at the time of writing and vary by provider, so check before relying on them. Traffic is usually small, since agents' model calls do not pass through it, though Git pushes and file uploads do.

Run it with:

```bash
CREW_RELAY_KEY=<long random secret> node bin/crew-relay.cjs 8443
```

Put it behind a TLS-terminating proxy, or set `CREW_RELAY_TLS_CERT` and `CREW_RELAY_TLS_KEY`. It refuses to start without a key unless you set `CREW_RELAY_OPEN=1`. Then in Crew Office: Host Office → Advanced → relay address and key.

## What the relay can and cannot see

It stores nothing and forgets everything on restart. **But TLS ends at the relay, so whoever runs it can read what passes through**: messages, project files, Git data, session cookies and Git tokens. End-to-end encryption is not possible here, because a browser would have to get its decryption code from somewhere, and that somewhere would be the relay.

It never sees AI credentials: those stay on each worker, and go only to each provider. A compromised relay could still act as a player it saw the session of. So run your own, or use one run by someone you trust.

## What a visitor can reach

Through the relay, only the office's pages, API and Git are there. Everything else on the server answers 404. A visitor can never count as this computer: requests carry a secret made fresh at each start, the host's forwarding headers and hostname are checked, and the machine key does not work from outside. Visitors cannot create rooms, and a bare room code does not open an office from outside. Only this server's own port is reachable through the tunnel, not anything else on the computer.

With a domain configured, each office gets its own hostname, so one office's page cannot read another's cookies. Without one, a relay serves a single office.

## Limits and abuse protection

**Host:** new players 30/hour per address, joins 20/minute, chat 30/minute, 12 open streams per player, 1 MB request bodies, 200 MB Git pushes.

**Relay:** 1200 requests/minute per address, 200 concurrent requests per office, 50 offices, 512 MB bodies, no unauthenticated hosts.

Invitations have 96 bits of randomness, expire in 72 hours by default, have limited uses, and can be revoked. Room passwords use scrypt.

## Connection statuses

The app shows only what is true now: **Hosting locally**, **Connecting to internet service**, **Connected through relay**, **Direct connection** (a LAN address), **Reconnecting**, **Internet hosting unavailable**. No invitation with a public address is offered until the relay has confirmed the tunnel.

## Safe internet hosting

1. Use Invite link privacy, and a relay you run or trust.
2. Stay on Balanced, or Supervised.
3. Install Docker on any computer that will run shared tests.
4. Revoke invitations you no longer need. Remove anyone who should not be there.
5. Check Security → Security record now and then.
6. Do not leave unattended autonomous agents in an internet-reachable office until you have done the two-computer checks in `SECURITY_TESTS.md`.

Port forwarding exposes this computer directly and is not recommended. On a network you do not trust, the LAN address is plain HTTP.
