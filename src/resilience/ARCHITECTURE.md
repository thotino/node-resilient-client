Le but est de construire un client en utilisant les patterns de résilience suivants:
* Retry
* Circuit-breaker
* Bulkhead
* Rate-limiter

Le client est entièrement configurable, gère les réessaies, protège ses ressources. Il prends en entrée une callback et retourne un résultat ou une erreur.
## Exigences fonctionnelles
* Exécution de la callback dans un délai prédéfini (timeout global)
* Réessaie de l'exécution de la callback en cas d'erreur de type Timeout
* Chaque essaie est limité dans le temps
* Gestion de l'indisponibilité du serveur distant (ouverture du circuit breaker)
* Gestion des requêtes identiques simultanées (via une calescence des requêtes)
## Exigences non fonctionnelles
# DECISIONS ARCHITECTURALES
## Retry
Le pattern de retry contrôle le timeout de chaque tentative. Et les timeouts sont rejoués.

Si `retry-after` est plus long que `maxDelay`, mieux vaut abandonner le retry. Le maxDelay est une sorte de SLA que je passe avec mon client.

* Ajouter un timeout global au niveau de la requête métier: il s'agit d'une deadline qui encadre l'ensemble de la requête métier et ne pas être confondu avec le timeout par tentative de retry.
Ce timeout global garantit que la requête métier respecte une écheance maximale.

* Décider quelles erreurs sont rejouables et lesquelles ouvrent le disjoncteur


Les erreurs rejouables sont:
* les timeouts métiers,
* les erreurs réseau temporaire (ECONNREFUSED, ECONNRESET)
* les erreurs 408
* les erreurs 429
* les erreurs HTTP 500, 
* les erreurs HTTP 502, 503, 504
Les erreurs à ne pas réessayer:
* les erreurs HTTP 400, 401, 403, 404, 409, 422
Le signal de timeout global et celui de la tentative sont combinés. Ainsi chaque requête peut être annulé par l'un ou l'autre des deux signaux.
## Circuit breaker
Décider quelles erreurs déclenchent l'ouverture du disjoncteur.
Traiter le problème de la concurrence si plusieurs requêtes arrivent au moment où le circuit est ouvvert. J'utilise une coalescence de requêtes mais au niveau du client et non pas au niveau du circuit breaker.
## Cache
Décider d'ajouter une politique de stale-while-revalidate. 

## Bulkhead
* Le délai d'un essai/d'une tentative par le Retry inclut l'attente du permis par le bulkhead. Le timeout de tentative couvre l'acquisition du permis. C'est la raison pour laquelle jepropage le signal combiné (tentative + global) au bulkhead.

## Comment composer les patterns?
* **LogicalOperationResilientClient (circuit breaker autour du retry)**
Le circuit observe le résultat final de l'opération protégé. Le circuit ne compte pas les erreurs transitoires intermédiaires comme des échecs distincts.
Avantages:
* une erreur transitoire corrigé par le retry ne provoque pas nécessairement l'ouverture du circuit
* le circuit mesure la capacité du système à réussir une opération après application de sa politique de retry.
Inconvénients:
* la détection d'une panne persistante est plus lente car le circuit attend la fin des retries.
* un fournisseur qui échoue sur presque toutes les tentaives peut ne pas déclencher rapidement le disjoncteur si quelques tentatives finissent par réussir.

* **PerAttemptResilientClient (circuit braker à l'intérieur du retry)**
Le circuit breaker observe chaque tentative individuelle du retry.
Avantages:
* le circuit breaker peut détecter plus vite une panne persistante
Inconvénients:
* le circuit breaker peut s'ouvrir au milieu d'une séquence de retry

L'ordre de Resilience4j:
```text
Retry ( CircuitBreaker ( RateLimiter ( TimeLimiter ( Bulkhead ( Function ) ) ) ) )
```
https://resilience4j.readme.io/docs/getting-started-3#aspect-order