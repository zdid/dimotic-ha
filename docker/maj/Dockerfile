# Agent de mise à jour de dimotic-ha (conception-mise-a-jour-dimotic_specs v1.1) — petit conteneur « maj ».
# Seul conteneur à recevoir le socket Docker de l'hôte (compose.deploy.yaml, profil `maj`) ; dimotic-ha n'y a jamais accès.
# Publié sous zdid2/dimotic-maj (amd64, arm64, arm/v7), versionné indépendamment de dimotic-ha.
FROM alpine:3.20
RUN apk add --no-cache docker-cli docker-cli-compose mosquitto-clients jq yq openssl curl
COPY maj-dimotic.sh /usr/local/bin/maj-dimotic.sh
RUN chmod +x /usr/local/bin/maj-dimotic.sh
ENTRYPOINT ["/usr/local/bin/maj-dimotic.sh"]
CMD ["--ecouter"]
