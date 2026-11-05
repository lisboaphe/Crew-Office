# Deploying the connectivity service

How to run the service that makes Host Office work over the internet, and how a build of the app finds it.

Until one is deployed and a build knows its address, **internet hosting does not work**: Host Office says **Internet service unavailable** and offers no link or room code. That is the correct behaviour, and nothing in the code can substitute for a running server. Somebody has to run this once. Friends never touch it.

## What it is

`bin/crew-relay.cjs`: one Node program with no dependencies. It does three things.

- **Tunnels.** A host dials out and keeps the connection open. Visitors' requests travel down it, so nobody forwards a port, and CGNAT does not matter.
- **Rendezvous.** Hosts publish the SHA-256 of each room code. `GET /_relay/resolve/<code>` turns a code into the office's address. It cannot list the codes it holds.
- **A front door.** On the bare domain, `/` asks for a code and `/j/<code>` redirects, for a friend with a code and nothing installed.

It writes nothing to disk. A restart forgets every tunnel and code until the hosts dial back in, which they do by themselves, keeping their address.

## Why a reverse tunnel

| Option | Fit with Crew Office | Verdict |
|---|---|---|
| WebRTC with ICE, STUN and TURN | Node has no built-in WebRTC, so a native dependency. A browser cannot load a page over a data channel, Git's HTTP client cannot use one, and TURN is a relay anyway | Rejected: every transport would be rewritten |
| Iroh and other QUIC libraries | Good for native peers. Native code, and browsers cannot join, so friends would have to install something | Rejected |
| Cloudflare Quick Tunnels | Free with no account, but its documentation says they do not support Server-Sent Events, which every live update here uses, cap in-flight requests at 200, and are meant for testing | Rejected |
| Reverse tunnel, as e4mc does | All traffic here is already HTTP, including Git and workers, and it needs no dependency | **Chosen** |

What that gives up: over the internet there is no direct path, so everything through the service costs its bandwidth. On the same network the app connects directly instead: a host announces a slow hash of each code by UDP, and a friend's app that hears its code goes to the host's LAN address. So "direct" is real, and limited to one network. Hole-punching between home routers is not implemented, because a browser friend could not use it.

## Deploying with Docker

You need a small server with Docker, ports 80 and 443 open, and a domain you control. Add two DNS records pointing at the server: `relay.example.org` and `*.relay.example.org`.

```bash
cp deploy/relay/.env.example deploy/relay/.env      # set the domain and email
docker compose -f deploy/relay/docker-compose.yml up -d --build
curl https://relay.example.org/_relay/info
```

Caddy gets each office's certificate from Let's Encrypt the first time it is asked for, after checking with the relay that the office exists. There is no wildcard certificate, so no DNS API credentials. Let's Encrypt limits how many certificates a domain may get per week, and each new office uses one, so a very busy service needs a wildcard certificate instead.

CI builds the image and runs it under the limits the compose file sets, and checks that the compose file and Caddy configuration are valid. That is `test/relay-image.test.cjs`. It cannot try real DNS, a real certificate or a whole deployment, none of which has been done yet, so do the checks below on the first deployment.

### Without Docker

```bash
CREW_RELAY_OPEN=1 CREW_RELAY_DOMAIN=relay.example.org CREW_RELAY_TRUST_PROXY=1 node bin/crew-relay.cjs 8443
```

Put any TLS proxy that passes `Upgrade` and does not buffer in front of it. Or set `CREW_RELAY_TLS_CERT` and `CREW_RELAY_TLS_KEY` to terminate TLS itself.

### One office, no domain of its own

Leave out `CREW_RELAY_DOMAIN`. The relay then serves one office on its whole address, which needs only one hostname and certificate. A second host is refused. Hosts add it under Advanced settings.

## Telling the app

The app looks in three places, first match wins:

1. **Advanced settings** on that computer, as a relay address and key.
2. `CREW_CONNECTIVITY_URL` in the environment or the app's `.env`, with `CREW_CONNECTIVITY_KEY` if the service wants one.
3. `build.json`, stamped by `installer/build.cjs` from `CREW_CONNECTIVITY_URL` when the app is built.

The third is what makes it automatic for everyone. Set the repository variable `CREW_CONNECTIVITY_URL` and `release.yml` stamps every build with it. A build refuses an address that is not `https://`, and so does the app, other than for loopback. A build with none prints that it has none.

The address is not secret, since it ships in a download. Nor can a key be, so a service baked into a public build runs with `CREW_RELAY_OPEN=1` and relies on its limits. Use `CREW_RELAY_KEY` for a private service whose hosts each enter the key.

## Authentication and encryption

- **Host to service:** TLS, then optionally the key. Each office then holds a secret for its tunnel, which is what keeps its address and lets it publish codes.
- **Visitor to service:** TLS. **It ends at the service**, so whoever runs it can read what passes through, including session cookies and Git tokens. `docs/security/NETWORK_SECURITY.md` says why end-to-end encryption is not possible for browser clients. Run your own, or use one run by someone you trust.
- **Visitor to office:** invitations and membership are checked by the host. The service decides nothing about who may enter an office.

## Limits

| Setting | Default | What it limits |
|---|---|---|
| `CREW_RELAY_MAX_TUNNELS` | 50 | Offices remembered. The one gone longest is forgotten first |
| `CREW_RELAY_TUNNELS_PER_IP` | 5 | Offices connected from one address |
| `CREW_RELAY_MAX_STREAMS` | 200 | Concurrent requests per office |
| `CREW_RELAY_RATE` | 1200 | Requests a minute per visitor address |
| `CREW_RELAY_RESOLVE_RATE` | 20 | Code look-ups a minute per address |
| `CREW_RELAY_MAX_BODY_MB` | 512 | One request's body |
| `CREW_RELAY_DAILY_MB` | 5120 when open, otherwise none | Traffic per office per day, both directions together |

An open service can be used by anyone running a copy of the program, to serve anything under your domain. So use a domain you do not use for anything else, and watch the metrics.

## Monitoring

```bash
curl https://relay.example.org/_relay/health
curl -H "Authorization: Bearer $KEY" https://relay.example.org/_relay/metrics
```

`health` is public: up, how long, how many offices. `metrics` needs `CREW_RELAY_METRICS_KEY`, or `CREW_RELAY_KEY`, and gives offices, streams, codes, bytes, refusals and the ten busiest offices by shortened name. Neither ever holds a code, a secret or a full office address.

The app checks more than this. After connecting, and every minute, a host fetches its own public address from outside and looks for a one-time nonce arriving down the tunnel. **Internet room available** appears only after that succeeds. It covers DNS, certificates and the proxy, and a failure shows up as the reason in Host Office.

## What it costs

Nothing here needs a subscription: the program is open source, and any cheap server runs it. You pay for the server, the domain and the traffic.

- **Server and domain:** see the table in `docs/security/NETWORK_SECURITY.md`. Prices vary, so check first.
- **Traffic:** agents' model calls never pass through it, since they go from each player's computer to their provider. Chat, tasks and status are small. **Git pushes and project files are the cost**: everything crosses the service twice, once in and once out, so a 1 GB push by a friend is about 2 GB of the server's traffic. Hosts on one network connect directly and use none. Lower `CREW_RELAY_DAILY_MB` to bound it, and check your provider's included transfer.

## Checking a deployment

Do this on the first deployment. None of it can be checked from one computer, and the automated tests do not cover real DNS, certificates or NAT.

1. `curl https://relay.example.org/_relay/info` shows `"service":"crew-relay"`.
2. On computer A, with `CREW_CONNECTIVITY_URL` set, press Host Office. **Internet room available** should appear within about thirty seconds, the first certificate being the slow part. If it says **Internet service unavailable**, the reason names what failed.
3. From a different connection, such as a phone hotspot, follow the rest of `docs/security/SECURITY_TESTS.md`.
