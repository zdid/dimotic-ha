## Accès direct à Home Assistant — pour CONTRÔLER des résultats

- URL : {{HA_URL}}
- Jeton (Long-Lived Access Token) : fichier `./ha_token` à côté de ce CLAUDE.md — ne l'affiche jamais
  en clair, ne le commite jamais, ne le partage jamais avec un service tiers.
- Usage prévu : **lecture** pour vérifier ce qu'on vient de mettre au point (états, historique, journal).
- Tout appel qui modifie quelque chose (services, configuration, automatisations) se confirme avec
  l'utilisateur AVANT, comme pour executer_action.

```bash
# États / un état
curl -s -H "Authorization: Bearer $(cat ha_token)" "{{HA_URL}}/api/states"
curl -s -H "Authorization: Bearer $(cat ha_token)" "{{HA_URL}}/api/states/light.salon"
# Historique d'une entité depuis une date
curl -s -H "Authorization: Bearer $(cat ha_token)" "{{HA_URL}}/api/history/period/2026-10-08T00:00:00?filter_entity_id=light.salon"
# Journal
curl -s -H "Authorization: Bearer $(cat ha_token)" "{{HA_URL}}/api/logbook"
```
