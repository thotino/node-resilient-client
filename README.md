# node-resilient-client

Un client TypeScript qui combine plusieurs mécanismes de résilience pour
exécuter des opérations asynchrones face aux erreurs temporaires et à la
saturation.

> 📌 Le dépôt est actuellement privé (`"private": true`). Les exemples
> d’installation ci-dessous concernent le travail depuis le dépôt, pas une
> installation depuis le registre npm.

## 🇫🇷 Français

### Fonctionnalités

Le client résilient compose trois mécanismes autour d’une callback :

- **Retry** — relance les erreurs considérées comme temporaires, avec un
  timeout par tentative et un backoff.
- **Circuit breaker** — coupe temporairement les appels lorsque les échecs
  s’accumulent, puis autorise des sondes de reprise.
- **Bulkhead** — limite les opérations simultanées et borne la file d’attente.

Deux utilitaires sont également implémentés séparément :

- **Rate limiter** — propose quatre algorithmes de limitation de débit.
- **Request coalescer** — partage la promesse d’une requête identique déjà en
  cours.

⚠️ Le rate limiter et le request coalescer ne sont pas intégrés aux clients
résilients et ne sont pas exportés depuis le point d’entrée `src/index.ts`.

### Combiner les patterns

Deux stratégies sont disponibles :

| Client | Composition | Comportement |
| --- | --- | --- |
| `LogicalOperationResilientClient` | Circuit breaker autour du retry | Le circuit observe le résultat final de l’opération. Une erreur temporaire récupérée par un retry n’est pas comptée comme un échec final. |
| `PerAttemptResilientClient` | Circuit breaker dans le retry | Le circuit observe chaque tentative et peut s’ouvrir avant que la séquence de retry soit terminée. |

Dans les deux cas, le bulkhead protège l’exécution de la callback. Le timeout
de tentative couvre aussi l’attente d’une place dans le bulkhead.

### Algorithmes

#### Retry

- `maxAttempts` inclut la première tentative.
- Le backoff exponentiel est plafonné :
  `min(initialDelay × factor^(tentative − 1), maxDelay)`.
- Les stratégies de jitter disponibles sont `none`, `full`, `equal` et
  `decorrelate`.
- Un en-tête HTTP `Retry-After` valide peut remplacer le délai calculé. Si le
  délai demandé dépasse `maxDelay`, le retry est abandonné.
- Les erreurs réseau temporaires (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`,
  `EPIPE`, `ENOTFOUND`, `ENETUNREACH`, `EAI_AGAIN`) et les réponses HTTP 408,
  429, 500, 502, 503 et 504 sont retryables par défaut.

Valeurs par défaut : 3 tentatives, délai initial de 1 000 ms, délai maximal de
30 000 ms, facteur 2, jitter `full` et timeout de 3 000 ms par tentative.

#### Circuit breaker

Le circuit suit les états `closed`, `open` et `half-open`. Après le nombre
d’échecs configuré, il s’ouvre; après `resetTimeout`, il passe en
`half-open` et laisse passer un nombre limité de sondes. Un échec de sonde
rouvre le circuit, tandis que le nombre requis de succès le referme.

Valeurs par défaut : seuil d’échec de 1, réinitialisation après 30 000 ms et
1 requête de sonde en état `half-open`.

#### Bulkhead

Le bulkhead se comporte comme un sémaphore : il plafonne le nombre
d’opérations concurrentes et maintient une file d’attente bornée. La
saturation de cette file, le dépassement du délai d’acquisition ou
l’annulation produisent des erreurs dédiées.

Valeurs par défaut : 10 opérations simultanées, 20 en attente et délai
d’acquisition maximal de 10 000 ms.

#### Rate limiter (utilitaire autonome)

Les quatre algorithmes disponibles sont :

1. **Fixed window** — compte les appels dans des fenêtres de temps fixes.
2. **Sliding window log** — conserve les instants des appels pour appliquer
   une fenêtre glissante exacte.
3. **Sliding window counter** — estime le débit de la fenêtre courante en
   pondérant le compteur de la fenêtre précédente.
4. **Token bucket** — consomme des jetons et les recharge au fil du temps,
   permettant des rafales limitées par la capacité du bucket.

Par défaut, les algorithmes à fenêtre autorisent 100 requêtes par minute; le
token bucket a une capacité de 10 jetons et recharge 1 jeton par seconde.
L’API indique si la requête est autorisée et le quota restant, ainsi que des
informations de réinitialisation ou d’attente selon l’algorithme.

#### Request coalescer (utilitaire autonome)

`RequestCoalescer.get(key, fn)` réutilise la promesse en cours pour une même
clé. L’entrée est supprimée après résolution comme après rejet : une
exécution ultérieure peut donc réessayer l’opération.

### Utilisation

```ts
import { LogicalOperationResilientClient } from "node-resilient-client";

const client = new LogicalOperationResilientClient({
  retryOptions: { maxAttempts: 3 },
  circuitBreakerOptions: { failureThreshold: 2 },
});
const abortController = new AbortController();

const result = await client.execute(
  ({ signal }) =>
    fetch("https://example.com/data", { signal }).then((response) => response.json()),
  { cancelSignal: abortController.signal },
);
```

La callback reçoit un `AbortSignal` et doit le transmettre à l’opération
concernée pour que celle-ci puisse être annulée. Le client accepte un
`cancelSignal` fourni par l’appelant; il ne crée pas de deadline globale
automatique. Le timeout par tentative est distinct de ce signal d’annulation.

Les erreurs de résilience exposent notamment un code, un message, ainsi que
les indicateurs `isRetryable` et `isCircuitBreakerFailure`. Les erreurs
spécifiques comprennent les timeouts, l’ouverture du circuit et le rejet ou
le timeout d’acquisition du bulkhead.

### Développement

```sh
npm install
npm run build
npm test
npm run lint
```

Les tests couvrent le retry, le circuit breaker, le bulkhead, le rate limiter
et le request coalescer.

---

## 🇬🇧 English

### Features

The resilient client composes three mechanisms around a callback:

- **Retry** — retries errors classified as transient, with a per-attempt
  timeout and backoff.
- **Circuit breaker** — temporarily stops calls when failures accumulate,
  then allows recovery probes.
- **Bulkhead** — limits concurrent operations and bounds the waiting queue.

Two additional utilities are implemented separately:

- **Rate limiter** — provides four rate-limiting algorithms.
- **Request coalescer** — shares the promise of an identical request that is
  already in flight.

⚠️ The rate limiter and request coalescer are not wired into the resilient
clients and are not exported from the `src/index.ts` entry point.

### Composing the patterns

Two strategies are available:

| Client | Composition | Behavior |
| --- | --- | --- |
| `LogicalOperationResilientClient` | Circuit breaker around retry | The circuit observes the final operation result. A transient error recovered by a retry does not count as a final failure. |
| `PerAttemptResilientClient` | Circuit breaker inside retry | The circuit observes each attempt and may open before the retry sequence is complete. |

In both strategies, the bulkhead protects callback execution. The
per-attempt timeout also covers waiting for a bulkhead permit.

### Algorithms

#### Retry

- `maxAttempts` includes the first attempt.
- Exponential backoff is capped:
  `min(initialDelay × factor^(attempt − 1), maxDelay)`.
- Available jitter strategies are `none`, `full`, `equal`, and `decorrelate`.
- A valid HTTP `Retry-After` header can replace the calculated delay. If the
  requested delay exceeds `maxDelay`, retrying is abandoned.
- Transient network errors (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`,
  `ENOTFOUND`, `ENETUNREACH`, `EAI_AGAIN`) and HTTP responses 408, 429, 500,
  502, 503, and 504 are retryable by default.

Defaults: 3 attempts, 1,000 ms initial delay, 30,000 ms maximum delay, factor
2, `full` jitter, and a 3,000 ms timeout per attempt.

#### Circuit breaker

The circuit uses the `closed`, `open`, and `half-open` states. After the
configured number of failures, it opens; after `resetTimeout`, it moves to
`half-open` and allows a limited number of probes. A failed probe reopens the
circuit, while the required number of successful probes closes it.

Defaults: failure threshold of 1, reset after 30,000 ms, and 1 probe request
in the `half-open` state.

#### Bulkhead

The bulkhead acts as a semaphore: it caps concurrent operations and keeps a
bounded waiting queue. A full queue, acquisition timeout, or cancellation
results in a dedicated error.

Defaults: 10 concurrent operations, 20 queued operations, and a maximum
acquisition wait of 10,000 ms.

#### Rate limiter (standalone utility)

Four algorithms are available:

1. **Fixed window** — counts calls in fixed time windows.
2. **Sliding window log** — stores call timestamps to enforce an exact
   rolling window.
3. **Sliding window counter** — estimates the current window's rate by
   weighting the previous window's counter.
4. **Token bucket** — consumes tokens and replenishes them over time, allowing
   bursts bounded by the bucket capacity.

By default, the window-based algorithms allow 100 requests per minute; the
token bucket has a capacity of 10 tokens and replenishes 1 token per second.
The API reports whether a request is allowed and the remaining quota, along
with reset or wait information depending on the algorithm.

#### Request coalescer (standalone utility)

`RequestCoalescer.get(key, fn)` reuses the in-flight promise for the same key.
The entry is removed after either resolution or rejection, so a later call
can retry the operation.

### Usage

```ts
import { LogicalOperationResilientClient } from "node-resilient-client";

const client = new LogicalOperationResilientClient({
  retryOptions: { maxAttempts: 3 },
  circuitBreakerOptions: { failureThreshold: 2 },
});
const abortController = new AbortController();

const result = await client.execute(
  ({ signal }) =>
    fetch("https://example.com/data", { signal }).then((response) => response.json()),
  { cancelSignal: abortController.signal },
);
```

The callback receives an `AbortSignal` and should pass it to the underlying
operation for cancellation to work. The client accepts a caller-provided
`cancelSignal`; it does not create an automatic global deadline. The
per-attempt timeout is distinct from this cancellation signal.

Resilience errors expose a code, a message, and the `isRetryable` and
`isCircuitBreakerFailure` flags. Dedicated errors cover timeouts, an open
circuit, and bulkhead acquisition rejection or timeout.

### Development

```sh
npm install
npm run build
npm test
npm run lint
```

Tests cover retry, circuit breaker, bulkhead, rate limiter, and request
coalescing.