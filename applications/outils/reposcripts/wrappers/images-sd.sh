#!/bin/bash
# Généré par l'application Outils — GÉRER les images de cartes SD/clés USB déjà créées par le script
# « Préparer et écrire une carte SD/clé USB » (⭐ 26/10/2026, demande utilisateur) : menu interactif
#   1) écrire une image de machine sur une carte (sans rien reconstruire),
#   2) supprimer une image (machine, base, échec ou image officielle téléchargée),
#   3) monter une image (partitions montées sous /mnt/image-<nom>, démontées quand on appuie sur Entrée).
#
# Travaille sur le MÊME dossier que le script de préparation : l'archive s'extrait dans le dossier fixe
# ~/.cache/dimotic-ha-outils (voir BundleBuilder.ts), les images sont dans data/.sd-card-image-cache/ :
#   prepared/<machine>.img (+ .profile.json)  image d'une machine, prête à écrire
#   base/<distribution>-<bits>-<clé>.img      image de base commune (cache)
#   *.echec                                    image laissée par un échec de construction
#   *.img / *.img.xz, orangepi/                images officielles téléchargées ou décompressées
# À lancer avec sudo (loop, montages, dd), depuis un vrai terminal.
#
# @outils:bundle applications/outils/reposcripts/scripts/prepare-sd-card.sh => scripts/prepare-sd-card.sh

set -uo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Ce script doit être lancé avec sudo (périphérique loop, montages, dd)." >&2
  exit 1
fi
[ -t 0 ] || { echo "Ce script est interactif : lancez-le depuis un vrai terminal (en SSH : ssh -t ...)." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/prepare-sd-card.sh" ]; then
  CACHE_DIR="$SCRIPT_DIR/data/.sd-card-image-cache"           # archive Outils (cas normal)
else
  CACHE_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)/data/.sd-card-image-cache"   # clone du dépôt
fi

human() { numfmt --to=iec --suffix=o "$1" 2>/dev/null || echo "$1 o"; }

# Remplit IMAGES (chemins) et KINDS (machine/base/échec/officielle), triés par type puis par nom.
list_images() {
  IMAGES=(); KINDS=()
  local f
  [ -d "$CACHE_DIR" ] || return 0
  while IFS= read -r f; do IMAGES+=("$f"); KINDS+=("machine"); done < <(find "$CACHE_DIR/prepared" -maxdepth 1 -type f -name '*.img' 2>/dev/null | sort)
  while IFS= read -r f; do IMAGES+=("$f"); KINDS+=("échec"); done < <(find "$CACHE_DIR" -type f \( -name '*.echec' -o -name '*.partial' \) 2>/dev/null | sort)
  while IFS= read -r f; do IMAGES+=("$f"); KINDS+=("base"); done < <(find "$CACHE_DIR/base" -maxdepth 1 -type f -name '*.img' 2>/dev/null | sort)
  while IFS= read -r f; do IMAGES+=("$f"); KINDS+=("officielle"); done < <(
    { find "$CACHE_DIR" -maxdepth 1 -type f \( -name '*.img' -o -name '*.img.xz' \); find "$CACHE_DIR/orangepi" -type f \( -name '*.img' -o -name '*.img.xz' -o -name '*.7z' \) 2>/dev/null; } | sort)
}

# Affiche les images dont le type est dans "$1" (ex. "machine" ou "machine échec base officielle") ; remplit SHOWN (index).
show_images() {
  SHOWN=()
  local i n=0 kind
  for i in "${!IMAGES[@]}"; do
    kind="${KINDS[$i]}"
    [[ " $1 " == *" $kind "* ]] || continue
    # largeur du type complétée à la main : printf compte les octets, « échec » serait décalé
    printf '  [%d] %s%*s %-48s %8s  %s\n' "$n" "$kind" $((10 - ${#kind})) '' "${IMAGES[$i]#"$CACHE_DIR"/}" "$(human "$(stat -c %s "${IMAGES[$i]}")")" "$(date -r "${IMAGES[$i]}" '+%d/%m/%Y %H:%M')"
    SHOWN+=("$i"); n=$((n + 1))
  done
  [ "$n" -gt 0 ] || echo "  (aucune image de ce type dans $CACHE_DIR)"
}

# Demande un numéro parmi SHOWN ; renvoie l'index dans IMAGES (ou rien si abandon).
pick_image() {
  local answer
  [ "${#SHOWN[@]}" -gt 0 ] || return 1
  read -r -p "Numéro de l'image (Entrée pour revenir) : " answer
  [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -lt "${#SHOWN[@]}" ] || return 1
  PICKED="${SHOWN[$answer]}"
}

# Amovibles de taille non nulle (même règle que flash-sd-card.js) : DEV_NAMES / DEV_SIZES / DEV_LABELS.
list_devices() {
  DEV_NAMES=(); DEV_SIZES=(); DEV_LABELS=()
  local line name size type rm tran model mounts
  while IFS= read -r line; do
    [[ "$line" =~ NAME=\"([^\"]*)\"\ SIZE=\"([^\"]*)\"\ TYPE=\"([^\"]*)\"\ RM=\"([^\"]*)\"\ TRAN=\"([^\"]*)\"\ MODEL=\"(.*)\"$ ]] || continue
    name="${BASH_REMATCH[1]}"; size="${BASH_REMATCH[2]}"; type="${BASH_REMATCH[3]}"; rm="${BASH_REMATCH[4]}"; tran="${BASH_REMATCH[5]}"; model="${BASH_REMATCH[6]}"
    [ "$type" = "disk" ] && { [ "$rm" = "1" ] || [ "$tran" = "usb" ]; } && [ "${size:-0}" -gt 0 ] || continue
    mounts="$(lsblk -nro MOUNTPOINT "/dev/$name" | grep -v '^$' | paste -sd, -)"
    DEV_NAMES+=("/dev/$name"); DEV_SIZES+=("$size"); DEV_LABELS+=("${model:-modèle inconnu} (${tran:-?})${mounts:+ — ⚠️ EN SERVICE, monté sur $mounts}")
  done < <(lsblk -dnbP -o NAME,SIZE,TYPE,RM,TRAN,MODEL)
}

action_flash() {
  echo; echo "Images de machine prêtes à écrire :"
  show_images "machine"
  pick_image || return 0
  local img="${IMAGES[$PICKED]}" img_size answer device mp
  img_size=$(stat -c %s "$img")
  while :; do
    list_devices
    echo
    if [ "${#DEV_NAMES[@]}" -eq 0 ]; then
      echo "Aucune carte/clé détectée (lecteur vide ?)."
    else
      echo "Périphériques amovibles détectés :"
      for i in "${!DEV_NAMES[@]}"; do
        local warn=""; [ "${DEV_SIZES[$i]}" -lt "$img_size" ] && warn="  ⚠️ trop petit"
        printf '  [%d] %s — %s — %s%s\n' "$i" "${DEV_NAMES[$i]}" "$(human "${DEV_SIZES[$i]}")" "${DEV_LABELS[$i]}" "$warn"
      done
    fi
    read -r -p "Numéro du périphérique à écrire, « r » pour relister, Entrée pour revenir : " answer
    case "$answer" in
      ''|q) return 0 ;;
      r) continue ;;
    esac
    [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -lt "${#DEV_NAMES[@]}" ] || { echo "Sélection invalide."; continue; }
    [ "${DEV_SIZES[$answer]}" -ge "$img_size" ] || { echo "Ce périphérique est plus petit que l'image."; continue; }
    device="${DEV_NAMES[$answer]}"
    echo; echo "⚠️  TOUT le contenu de $device ($(human "${DEV_SIZES[$answer]}"), ${DEV_LABELS[$answer]}) va être définitivement écrasé."
    read -r -p "Retapez exactement « $device » pour confirmer : " answer
    [ "$answer" = "$device" ] || { echo "Confirmation invalide — rien n'a été écrit."; continue; }
    break
  done
  while IFS= read -r mp; do [ -n "$mp" ] && { echo "Démontage de $mp..."; umount "$mp" || true; }; done < <(lsblk -nro MOUNTPOINT "$device")
  echo "Écriture de $(basename "$img") sur $device..."
  if dd if="$img" of="$device" bs=4M status=progress conv=fsync; then
    sync; partprobe "$device" 2>/dev/null || true
    echo "✅ Écriture terminée — carte prête. L'agrandissement à la taille de la carte se fait au premier démarrage."
  else
    echo "❌ Échec de l'écriture (dd) sur $device." >&2
  fi
}

action_delete() {
  echo; echo "Images présentes :"
  show_images "machine échec base officielle"
  pick_image || return 0
  local img="${IMAGES[$PICKED]}" kind="${KINDS[$PICKED]}" name answer
  name="$(basename "$img")"
  if losetup -j "$img" 2>/dev/null | grep -q .; then
    echo "Cette image est en cours d'utilisation (montée ou attachée) — démontez-la d'abord."; return 0
  fi
  case "$kind" in
    base) echo "Image de base : la prochaine préparation avec les mêmes choix la reconstruira (long, dans qemu)." ;;
    officielle) echo "Image officielle : elle sera retéléchargée (ou, pour une Orange Pi, redécompressée) à la prochaine préparation." ;;
    machine) echo "Image de machine : relancer la préparation de cette machine la recréera (quelques secondes si la base est en cache)." ;;
  esac
  read -r -p "Retapez exactement « $name » pour supprimer ($(human "$(stat -c %s "$img")")) : " answer
  [ "$answer" = "$name" ] || { echo "Confirmation invalide — rien n'a été supprimé."; return 0; }
  rm -f -- "$img"
  [ "$kind" = "machine" ] && rm -f -- "${img%.img}.profile.json"
  echo "✅ Supprimée : ${img#"$CACHE_DIR"/}"
}

MOUNT_LOOP=""; MOUNT_ROOT=""
unmount_all() {
  local d
  if [ -n "$MOUNT_ROOT" ]; then
    sync
    for d in "$MOUNT_ROOT"/*; do mountpoint -q "$d" 2>/dev/null && umount "$d"; rmdir "$d" 2>/dev/null; done
    rmdir "$MOUNT_ROOT" 2>/dev/null
  fi
  [ -n "$MOUNT_LOOP" ] && losetup -d "$MOUNT_LOOP" 2>/dev/null
  MOUNT_LOOP=""; MOUNT_ROOT=""
}
trap unmount_all EXIT
trap 'echo; unmount_all; exit 130' INT TERM

action_mount() {
  echo; echo "Images montables :"
  show_images "machine échec base officielle"
  pick_image || return 0
  local img="${IMAGES[$PICKED]}" slug part fstype label dir answer mode="rw" n=0
  case "$img" in *.xz|*.7z) echo "Image compressée : elle ne se monte pas telle quelle (la version décompressée .img est aussi dans la liste)."; return 0 ;; esac
  read -r -p "Monter en lecture seule ? [O/n] : " answer
  [[ "$answer" =~ ^[nN] ]] && mode="rw" || mode="ro"
  slug="$(basename "$img" | sed -E 's/\.(img|echec|partial)$//; s/[^A-Za-z0-9._-]+/-/g')"
  MOUNT_ROOT="/mnt/image-$slug"
  if [ -e "$MOUNT_ROOT" ]; then echo "$MOUNT_ROOT existe déjà (image déjà montée ?) — rien n'est fait."; MOUNT_ROOT=""; return 0; fi
  MOUNT_LOOP="$(losetup -fP --show $([ "$mode" = ro ] && echo -r) "$img")" || { echo "Impossible d'attacher l'image."; MOUNT_LOOP=""; return 0; }
  mkdir -p "$MOUNT_ROOT"
  for part in "${MOUNT_LOOP}"p*; do
    [ -b "$part" ] || continue
    fstype="$(blkid -o value -s TYPE "$part" 2>/dev/null)"
    [ -n "$fstype" ] || continue
    case "$fstype" in vfat) label="boot" ;; ext4|ext3|ext2|btrfs|f2fs) label="racine" ;; *) label="partition" ;; esac
    dir="$MOUNT_ROOT/$label"; [ -e "$dir" ] && dir="$MOUNT_ROOT/$label-${part##*p}"
    mkdir -p "$dir"
    if mount -o "$mode" "$part" "$dir"; then echo "  ${part##*/} ($fstype) -> $dir"; n=$((n + 1)); else rmdir "$dir"; fi
  done
  if [ "$n" -eq 0 ]; then echo "Aucune partition montable dans cette image."; unmount_all; return 0; fi
  echo
  echo "Image montée en $([ "$mode" = ro ] && echo "LECTURE SEULE" || echo "LECTURE-ÉCRITURE (les modifications sont gardées dans l'image)") sous $MOUNT_ROOT"
  echo "Consultez-la depuis un autre terminal ou le gestionnaire de fichiers (fichiers de root : sudo pour modifier)."
  read -r -p "Appuyez sur Entrée pour démonter... " _
  unmount_all
  echo "✅ Image démontée."
}

echo "Dossier des images : $CACHE_DIR"
while :; do
  list_images
  echo
  echo "=== Images de cartes SD (${#IMAGES[@]} fichier(s), $(du -sh "$CACHE_DIR" 2>/dev/null | cut -f1 || echo 0) au total)"
  show_images "machine échec base officielle"
  echo
  echo "  1) Écrire une image de machine sur une carte"
  echo "  2) Supprimer une image"
  echo "  3) Monter une image"
  echo "  q) Quitter"
  read -r -p "Choix : " choice || break
  case "$choice" in
    1) action_flash ;;
    2) action_delete ;;
    3) action_mount ;;
    q|Q|'') break ;;
    *) echo "Choix inconnu." ;;
  esac
done
