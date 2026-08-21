/*
 * Copyright 2010-2011 Brian Uechi <buasst@gmail.com>
 *
 * This file is part of mochad.
 *
 * mochad is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * mochad is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with mochad.  If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * TCP gateway to X10 CM15A X10 RF and PL controller and TL500 RF controller.
 * Decode data from CM15A/TL500 ignoring macros and timers. This driver treats
 * the CM15A as a transceiver. The CM15A macros, timers, and real-time clock
 * (RTC) are ignored. In fact, the CM15A memory should be cleared using
 * ActiveHome Pro (AHP) before using the CM15A is with this driver. Batteries
 * are not necessary because the RTC is not used. The CM15A RF to PL converter
 * should be disabled for all house codes using AHP.  The TL500 does not
 * supports macros, timers, or RTC so it can be used as-is.
 */

#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <stdarg.h>
#include <stdlib.h>
#include <signal.h>
#include <poll.h>
#include <time.h>
#include <errno.h>
#include <unistd.h>

/* ⭐ 19/08/2026 — ajout envoi HTTP (solution de secours si le TL-500 principal tombe en panne,
 * voir discussion) : mêmes champs que rf_usb_http.elf (type/id/time/v/rssi), vers le récepteur
 * HttpServ déjà en place (arexx2hass) — aucun changement côté TypeScript nécessaire. */
#include <sys/socket.h>
#include <netdb.h>

/**** system log ****/
#include <syslog.h>

/* Multiple On-line Controllers Home Automation Daemon */
#define DAEMON_NAME "tl500"

#include "global500.h"


#define USB_FDS         (10)    /* libusb file descriptors */

#define true 1
#define false 0

static struct pollfd Clients[USB_FDS];

/**** USB usblib 1.0 ****/

#include <libusb-1.0/libusb.h>
uint8_t InEndpoint, OutEndpoint;

static struct libusb_device_handle *Devh = NULL;
static struct libusb_transfer *IntrOut_transfer = NULL;
static struct libusb_transfer *IntrIn_transfer = NULL;
static unsigned char IntrOutBuf[8];
static unsigned char IntrInBuf[8];



/*** debug ***/

#define dbprintf(fmt, ...) _dbprintf(fmt, __FILE__,__LINE__, ## __VA_ARGS__)
int _dbprintf(const char *fmt, ...)
{
    va_list args;
    char buf[1024];
    char fmtbig[1024];
//    int buflen;

    va_start(args,fmt);
    strcpy(fmtbig, "%s:%d:");
    strcat(fmtbig, fmt);
//    buflen = 
	vsprintf(buf, fmtbig, args);
    va_end(args);
    int ret= fprintf(stderr, "%s\n", buf);
    fflush(stderr);
    return ret;
}


static void _hexdump(void *p, size_t len, char *outbuf, size_t outlen)
{
    unsigned char *ptr = (unsigned char*) p;
    size_t l;

    if (len == 0) return;
    if (len > (outlen / 3))
        l = outlen / 3;
    else
        l = len;
    while (l--) {
        sprintf(outbuf, "%02X ", *ptr++);
        outbuf += 3;
    }
}

void hexdump(void *p, size_t len)
{
    char buf[(3*100)+1];

    _hexdump(p, len, buf, sizeof(buf));
    perror(buf);
    //fprintf(stderr, "%s\n", buf);
}
/** fin debug **/

static int Do_exit = 0;
static int Reattach = 0;



#define TL_500_VENDOR     1105
#define TL_500_PRODUCT    12817


/* Find TL500 with
 * vendor and product IDs, respectively.
 */
static int find_tl500(struct libusb_device_handle **devhptr)
{
    int r;

    *devhptr = libusb_open_device_with_vid_pid(NULL,  TL_500_VENDOR, TL_500_PRODUCT);
    if (!*devhptr) {
            syslog(LOG_EMERG, "libusb_open_device_with_vid_pid failed");
            return -EIO;
    }
    r = libusb_claim_interface(*devhptr, 0);
    if (r == 0) {
        syslog(LOG_NOTICE, "Found TL500 1" );
        return 0;
    }
    syslog(LOG_EMERG, "usb_claim_interface failed %d", r);
    r = libusb_kernel_driver_active(*devhptr, 0);
    if (r < 0) {
        syslog(LOG_EMERG, "Kernel driver check failed %d", r);
        return -EIO;
    }
    syslog(LOG_NOTICE, "Found kernel driver %d, trying detach", r);
    r = libusb_detach_kernel_driver(*devhptr, 0);
    if (r < 0) {
        syslog(LOG_EMERG, "Kernel driver detach failed %d", r);
        return -EIO;
    }
    Reattach = 1;
    r = libusb_claim_interface(*devhptr, 0);
    if (r < 0) {
        syslog(LOG_EMERG, "claim interface failed again %d", r);
        return -EIO;
    }
    syslog(LOG_NOTICE,  "Found TL500 2" );
    return 0;
}

/* Find the in and out endpoint address in the device descriptors.
 * This is required by newer TL500 that have changed endpoint addresses.
 */
static int get_endpoint_address(libusb_device_handle *devh, uint8_t *inendpt, uint8_t *outendpt)
{
    int r;
    struct libusb_config_descriptor *config;
    const struct libusb_interface *interfaces;
    const struct libusb_interface_descriptor *interface_desc;
    const struct libusb_endpoint_descriptor *endpoint_desc;
    struct libusb_device *uDevice;
    struct libusb_device_descriptor desc;
    int i, j, k;

    uDevice = libusb_get_device(devh);
    if (!uDevice) return -1;

    r = libusb_get_device_descriptor(uDevice, &desc);
    if (r < 0) return r;

    r = libusb_get_active_config_descriptor(uDevice, &config);
    if (r < 0) return r;
    interfaces = config->interface;
    for (i = 0; i < config->bNumInterfaces; i++) {
        interface_desc = interfaces->altsetting;
        for (j = 0; j < interfaces->num_altsetting; j++) {
            endpoint_desc = interface_desc->endpoint;
            for (k = 0; k < interface_desc->bNumEndpoints; k++) {
                if (endpoint_desc->bEndpointAddress & 0x80) {
                    *inendpt = endpoint_desc->bEndpointAddress;
                }
                else {
                    *outendpt = endpoint_desc->bEndpointAddress;
                }
                endpoint_desc++;
            }
            interface_desc++;
        }
        interfaces++;
    }
    libusb_free_config_descriptor(config);
    return 0;
}

static void IntrOut_cb(struct libusb_transfer *transfer)
{
    /* dbprintf("IntrOut callback len %d\n", transfer->actual_length); */
}

//***  ASupprimer ***/
static void tl500_decode( buffer, actual_length) {
	dbprintf("tl500_decode callback len %d\n", actual_length);
}
//*** Fin ASupprimer ***/
 
//** QUOITESTCE a priori je ne men sers pas */
static void IntrIn_cb(struct libusb_transfer *transfer)
{

    //int fd;
    // int i;

    if (transfer->status != LIBUSB_TRANSFER_COMPLETED) {
        dbprintf("IntrIn transfer status %d?\n", transfer->status);
        Do_exit = 2;
        libusb_free_transfer(transfer);
        IntrIn_transfer = NULL;
        return;
    }

    /* dbprintf("IntrIn callback len %d ", transfer->actual_length); */
    /* hexdump(transfer->buffer, transfer->actual_length); */

    if (transfer->actual_length == 1) {
        // send_next_x10out();
    }


    /* Incoming USB data is sent to all sockets */
     tl500_decode( transfer->buffer, transfer->actual_length);
     if (libusb_submit_transfer(IntrIn_transfer) < 0)
        Do_exit = 2;
}

static int start_transfers(void)
{
	return 0;
    int r;

    r = libusb_submit_transfer(IntrIn_transfer);
    if (r < 0)
        return r;
    return 0;
}


static int alloc_transfers(void)
{
    IntrIn_transfer = libusb_alloc_transfer(0);
    if (!IntrIn_transfer)
        return -ENOMEM;
    libusb_fill_interrupt_transfer(IntrIn_transfer, Devh, InEndpoint, 
            IntrInBuf, sizeof(IntrInBuf), IntrIn_cb, NULL, 0);

    IntrOut_transfer = libusb_alloc_transfer(0);
    if (!IntrOut_transfer)
        return -ENOMEM;
    return 0;
}

int write_usb(unsigned char *buf, size_t len)
{
    int r, i;

    dbprintf("usb len %lu ", (unsigned long)len);
    hexdump(buf, len);
    memcpy(IntrOutBuf, buf, len);
    libusb_fill_interrupt_transfer(IntrOut_transfer, Devh, OutEndpoint, 
            IntrOutBuf, len, IntrOut_cb, NULL, 0);
    r = libusb_submit_transfer(IntrOut_transfer);
    if (r < 0) {
        libusb_cancel_transfer(IntrOut_transfer);
        i = 100;
        while (IntrOut_transfer && i--)
            if (libusb_handle_events(NULL) < 0)
                break;
        return r;
    }
    return 0;
}
//** fin QUOITESTCE a priori je ne men sers pas */

static void sighandler(int signum)
{
    Do_exit = 1;	
}
// USB poll frequency in microseconds.

#define POLL_FREQUENCY    1 * 1000 * 1000;

// Max number of USB access errors before reinitializing usblib.

#define MAX_ERRORS        10
#define PACKET_SIZE       64
#define BUFFER_SIZE       250
#define SENSOR1_TYPE_3TSN  0x2
#define SENSOR1_TYPE_TH70E 0x4
#define SENSOR_TYPE_TEMP_OUT 1
#define SENSOR_TYPE_RH_OUT 3




/**
 * Returns the local system time in yyyy-mm-dd hh:mm:ss notation.
 */

static char timestamp[20];

static char *system_time() {

	const time_t t = time(NULL);
	struct tm *tm = localtime(&t);

	snprintf(timestamp, sizeof(timestamp), "%4d-%02d-%02d %02d:%02d:%02d",
		tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday, tm->tm_hour, tm->tm_min, tm->tm_sec);

	return timestamp;
}

/**
 * Returns the sensor ID number.
 */

int get_sensor (unsigned char data[PACKET_SIZE],int position, int decalage) {
	int num = data[2+position] * 256 + data[1+position];
	int i;
	int mul = 256*256;
	if(decalage) {
		num+=data[position+3]*65536;
	}
	return num;
}

/**
 * Returns the type de materiel
 */

int get_type (unsigned char data[PACKET_SIZE],int position,int decalage) {
	int num = (data[position+2+decalage]&0xf0)>>4;
	return num;
}


/**
 * Returns the raw value.
 */

int get_value (unsigned char data[PACKET_SIZE],int position,int decalage) {

	return (data[3+position+decalage] << 8) + data[4+position+decalage];
}
/**
 * Returns the valtime.
 */			   
int difference_1970_2000 = 946684800;
long get_valtime (unsigned char data[PACKET_SIZE],int position,int decalage) {
	// TODO la formule n'est pas la bonne la date a priori oui mais pas l'heure
	// 

	long val =0;
	if(data[7+position+decalage] == 0 && data[8+position+decalage] == 0) {
		val = time(NULL) - difference_1970_2000;
	} else {
 		val = (long)data[5+position+decalage]+(long)data[6+position+decalage]*256 + (long)data[7+position+decalage]*65536 + (long)data[8+position+decalage]*16777216;
	} 
	return val;
}

struct Unsensor {
	int longueur;
	int historique;
	int num;
	int type;
	int rawvalue;
	double value;
	int valtime;
	int dbm; /* ⭐ 21/08/2026 — octet BRUT du paquet (data[...+9] ou +11], voir plus bas), PAS un
	          * vrai dBm : aucune formule de conversion documentée trouvée (device.xml de
	          * rf_usb_http.elf ne couvre que les types de mesure, pas la calibration signal).
	          * Comparé empiriquement à rf_usb_http.elf sur bs510 le 21/08/2026 : capteur 11719,
	          * tl-500 rapportait dbm=41 (brut) quand rf_usb_http.elf rapportait un vrai dBm
	          * négatif (-81 à -92) au même moment — une seule paire de points, insuffisant pour
	          * en déduire une formule fiable (2 inconnues, pente+décalage). Ne pas interpréter
	          * cette valeur comme un dBm réel tant qu'une vraie calibration n'est pas établie. */
	int anomalie;
	int typecapt;
	char* unit;
}  ;

/* ⭐ 19/08/2026 — TEMPORAIRE : le dbprintf de diagnostic dans send_http_get() est volontairement
 * verbeux pour valider la solution de secours en conditions réelles ; à retirer (ou passer en
 * commentaire) une fois le fonctionnement confirmé, garder juste le fprintf(stderr) d'erreur. */

static char TargetHost[128] = "localhost";
static int TargetPort = 49161;

/**
 * Lit l'URL cible depuis un fichier de config transmis avec l'exécutable (une ligne,
 * "host:port" ou juste "host") — remplace TargetHost/TargetPort par défaut si le fichier est
 * absent ou invalide (pas bloquant, juste un fallback local).
 */
static void read_url_config(const char *path) {
	FILE *f = fopen(path, "r");
	if (!f) {
		dbprintf("[TEMPORAIRE] fichier de config URL '%s' introuvable, utilisation de %s:%d par defaut", path, TargetHost, TargetPort);
		return;
	}
	char line[256];
	if (fgets(line, sizeof(line), f)) {
		line[strcspn(line, "\r\n")] = 0;
		char *colon = strchr(line, ':');
		if (colon) {
			*colon = 0;
			strncpy(TargetHost, line, sizeof(TargetHost) - 1);
			TargetPort = atoi(colon + 1);
		} else if (line[0] != 0) {
			strncpy(TargetHost, line, sizeof(TargetHost) - 1);
		}
	}
	fclose(f);
	dbprintf("[TEMPORAIRE] config URL chargee depuis '%s' : %s:%d", path, TargetHost, TargetPort);
}

/**
 * Envoie une requête HTTP POST (form-urlencoded) vers TargetHost:TargetPort avec les champs
 * fournis (déjà construits par l'appelant, mêmes champs que rf_usb_http.elf : type/id/time/v/
 * rssi) — socket TCP brut, pas de dépendance à libcurl pour un besoin aussi simple. Non bloquant
 * sur échec : une mesure perdue n'est pas fatale.
 *
 * ⭐ 19/08/2026 — POST, pas GET : vérifié contre le vrai récepteur en production
 * (applications/arexx/src/domain/acquisition/PushReceiver.ts, dimotic-ha) qui lit
 * exclusivement req.body (middleware express.urlencoded) — un GET avec query string n'a pas de
 * corps, req.body serait vide et la lecture rejetée ("ko"). D'abord écrit en GET par erreur,
 * corrigé avant tout test contre ce récepteur réel.
 */
static void send_http_get(const char *query) {
	struct addrinfo hints, *res;
	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;

	char portstr[8];
	snprintf(portstr, sizeof(portstr), "%d", TargetPort);

	int gai = getaddrinfo(TargetHost, portstr, &hints, &res);
	if (gai != 0) {
		fprintf(stderr, "HTTP: echec resolution %s: %s\n", TargetHost, gai_strerror(gai));
		return;
	}

	int sock = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
	if (sock < 0) {
		fprintf(stderr, "HTTP: echec creation socket: %s\n", strerror(errno));
		freeaddrinfo(res);
		return;
	}

	if (connect(sock, res->ai_addr, res->ai_addrlen) < 0) {
		fprintf(stderr, "HTTP: echec connexion a %s:%d: %s\n", TargetHost, TargetPort, strerror(errno));
		close(sock);
		freeaddrinfo(res);
		return;
	}
	freeaddrinfo(res);

	int bodylen = strlen(query);
	char request[1280];
	int reqlen = snprintf(request, sizeof(request),
		"POST / HTTP/1.1\r\nHost: %s\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		TargetHost, bodylen, query);

	dbprintf("[TEMPORAIRE] HTTP: envoi POST / (corps: %s) vers %s:%d", query, TargetHost, TargetPort);

	if (write(sock, request, reqlen) < 0) {
		fprintf(stderr, "HTTP: echec envoi: %s\n", strerror(errno));
		close(sock);
		return;
	}

	char response[256];
	int n = read(sock, response, sizeof(response) - 1);
	if (n > 0) {
		response[n] = 0;
		dbprintf("[TEMPORAIRE] HTTP: reponse recue: %.60s", response);
	}
	close(sock);
}


static int traitementMessage(unsigned char data[PACKET_SIZE], int ignoreHistorique) {
	int deplacement = 1;
	int indice = 0;
	char buffer[BUFFER_SIZE] = "";
	int onlyhistorique = true;
	 
	/* 
	 * les historiques arrivent par paquets de 5
	 */
	while(1) {
	   struct Unsensor s;
	   //longueur le dernier aura une longueur de zero
	   s.longueur = data[deplacement] ;
	   s.anomalie = false;
	   if(s.longueur == 0) break;

	   /*
	    * lecure des données ancien et nouveau format
	    */
	   s.dbm = 0;
	   s.anomalie = false;
	   s.historique = false;
	   /*
	    * ancien formats longueur = 9 ou 10 
	    * nouveaux formats lg = 10 ou 11
	    * pas de dernier caractere pour l'historique
	    */
	   if(s.longueur == 9 || s.longueur == 11) {
		s.historique = true;
	   }
	   if(!(ignoreHistorique == true && s.historique == true)) {
		switch(s.longueur) {
			case 10: // ancien sensor en cours
				onlyhistorique = false;
				s.dbm = data[deplacement+9]; 
			case 9 : // ancien sensor historique 
				s.num = get_sensor(data,deplacement,0); 
				s.type = get_type(data,deplacement,0);
				s.rawvalue = get_value(data,deplacement,0);
				s.valtime  = get_valtime(data,deplacement,0);
				break;
			case 12 : // nouveau sensor en cours
				onlyhistorique = false;
				s.dbm = data[deplacement+11]; 
			case 11 : // nouveau sensor historique
				s.num = get_sensor(data,deplacement,2); 
				s.type = get_type(data,deplacement,2);
				s.rawvalue = get_value(data,deplacement,2);
				s.valtime  = get_valtime(data,deplacement,2);
				break;
			default:
				s.anomalie = true;
				break;		
		} //fin switch
		/* 
		 * calcul du resultat selon le type de capteur
		 */
		if(s.anomalie==false) {
		switch (s.type) {
			case SENSOR1_TYPE_3TSN:
  			      s.value = ((short int)s.rawvalue) * 0.0078125;
			      s.unit = "C";
			      s.typecapt = SENSOR_TYPE_TEMP_OUT;
			      break;
			case SENSOR1_TYPE_TH70E:
             			if(s.num % 2 == 0) {
                			s.value = -39.58 + ((short int)s.rawvalue) * 0.01;
			      		s.unit = "C";
			      		s.typecapt = SENSOR_TYPE_TEMP_OUT;
	         		} else {
                			s.value = 0.698847572766711 + 
                            			0.0322868348833273 * s.rawvalue + 
                            			0.00000175838509577984 * s.rawvalue * s.rawvalue -
                            			0.000000000764068120532725 * s.rawvalue * s.rawvalue * s.rawvalue;
					s.unit = "%RH";
				        s.typecapt = SENSOR_TYPE_RH_OUT;
					s.num-=1;
				}

			break;
			default:
				s.anomalie= true;
			break;
		} // fin switch
		} // if anomalie
		if(s.anomalie == true) {
			fprintf(stderr, "packet from sensor %d unsupported type 0x%x\n", s.num, s.type);
			fprintf(stderr, "indice %d data \n", indice);
			hexdump(data,PACKET_SIZE);
			fflush(stderr);
		} 
		if(s.anomalie == false) {
                  snprintf(buffer, BUFFER_SIZE, 
			"RESUL{ \"date\": %d, \"id\": \"%d%s, \"typecapt\" : %d,\"rawvalue\" : %d, \"value\": %2.1f, \"unit\": \"%s\", \"valtime\": %d , \"dbm\": %d,\"historique\": \"%s\"   }\n", 
			time(NULL), s.num, (s.typecapt == SENSOR_TYPE_RH_OUT?"RH\"":"\""),s.typecapt, s.rawvalue, s.value, s.unit,s.valtime,s.dbm, (s.historique==true?"h":"a"));
		   fprintf(stdout,"%s",buffer);
		   fflush(stdout);

		   /* ⭐ 19/08/2026 — envoi vers le récepteur HTTP existant (arexx2hass), mêmes champs
		    * que rf_usb_http.elf. "missing" = valtime, comme documenté dans le ReadMe original
		    * de rf_usb_http (champ non utilisé côté récepteur mais toujours envoyé).
		    * ⭐ 21/08/2026 — le champ "rssi" envoyé ici est s.dbm, une valeur BRUTE non calibrée
		    * (voir commentaire sur struct Unsensor::dbm) — pas un vrai dBm comme celui envoyé
		    * par rf_usb_http.elf. Le récepteur (PushReceiver.ts, dimotic-ha) fait
		    * `parseFloat(body.rssi)` sans distinction de source : cette valeur y arrivera donc
		    * comme un "signalDbm" trompeur tant que la calibration n'est pas établie. */
		   {
		     char query[256];
		     snprintf(query, sizeof(query), "type=%d&id=%d&time=%d&v=%.1f&rssi=%d&missing=%d",
		       s.typecapt, s.num, s.valtime, s.value, s.dbm, s.valtime);
		     send_http_get(query);
		   }
       		}  //fin if(s.anomalie == false)

	    }	// fin	if(!(ignoreHistorique == true && s.historique == true)) {

		deplacement += s.longueur;
		indice+=1;
	} // fin while

	return onlyhistorique ;
}
#define POLL_RAPIDE 50000
static int do_collect(libusb_device_handle *handle,int ignorehistorique) {

	unsigned char dataUp[PACKET_SIZE];
	unsigned char dataDown[PACKET_SIZE];

	int actual_length = 0;
	int errors = 0;
	int r;
	//int first = 0;

	// intial poll delay used to purge 00 00 packets

        int poll_delay = POLL_RAPIDE;
 
	memset(dataDown, 0, PACKET_SIZE);
	dataDown[0] = 4;
	libusb_bulk_transfer(handle, OutEndpoint, dataDown, sizeof(dataDown), &actual_length, 1000);
	dataDown[0] = 3;
	
	while(!Do_exit) {
		r = libusb_bulk_transfer(handle, OutEndpoint, dataDown, sizeof(dataDown), &actual_length, 1000);
		if (r == LIBUSB_ERROR_NO_DEVICE)
			break;
		r = libusb_bulk_transfer(handle, InEndpoint, dataUp, sizeof(dataUp), &actual_length, 1000);
		if (r == LIBUSB_ERROR_NO_DEVICE)
			break;
		if (r == 0 && actual_length == sizeof(dataUp)) {
			int ishistorique = traitementMessage(dataUp,ignorehistorique);
			if(ishistorique == false ) {
				//dbprintf("je positionne le POLL_FREQUENCY");
				//first = 0;
				poll_delay = POLL_FREQUENCY;
			} else {
				//dbprintf("je positionne le POLL_RAPIDE");
				poll_delay = POLL_RAPIDE;
			}
	      	} else if(errors++ >= MAX_ERRORS) {
			break;
        	}

		usleep(poll_delay);
	}

	if(errors >= MAX_ERRORS)
		fprintf(stderr, "Too many errors, giving up.\n");

	else if(r == LIBUSB_ERROR_NO_DEVICE)
		fprintf(stderr, "Lost USB device.\n");

 	Do_exit	= 1;
	return 0;
}

static int mydaemon(int ignorehistorique)
{
   
    int i;
    /**** USB ****/
    struct sigaction sigact;
    int r = 1;
    const struct libusb_pollfd **usbfds;
    nfds_t nusbfds;
    struct timeval timeout;


    r = libusb_init(NULL);
    if (r < 0) {
        syslog(LOG_EMERG, "failed to initialise libusb %d", r);
        dbprintf("failed to initialise libusb %d\n", r);
        exit(1);
    }
    libusb_set_debug(NULL, 3);


    /* This function is not available in older versions of libusb-1.0 */
    r = libusb_pollfds_handle_timeouts(NULL);
    if (!r) {
        dbprintf("poll timeout required %d\n", r);
        goto out;
    }

    r = find_tl500(&Devh);

    if (r < 0) {
        syslog(LOG_EMERG, "Could not find/open TL500 %d", r);
        dbprintf("Could not find/open TL500 %d\n", r);
        goto out;
    }
 	

    r = get_endpoint_address(Devh, &InEndpoint, &OutEndpoint);
    if (r < 0) {
        syslog(LOG_EMERG, "Could not find endpoints %d", r);
        dbprintf("Could not find endpoints %d\n", r);
        goto out_deinit;
    }
    syslog(LOG_EMERG, "Find/open TL500 ");
    syslog(LOG_NOTICE, "In endpoint 0x%02X, Out endpoint 0x%02X",
            InEndpoint, OutEndpoint);


 //   r = alloc_transfers();
    if (r < 0)
        goto out_deinit;

    r = start_transfers();
     if (r < 0)
        goto out_deinit;

    sigact.sa_handler = sighandler;
    sigemptyset(&sigact.sa_mask);
    sigact.sa_flags = 0;
    sigaction(SIGINT, &sigact, NULL);
    sigaction(SIGTERM, &sigact, NULL);
    sigaction(SIGQUIT, &sigact, NULL);

    usbfds = libusb_get_pollfds(NULL);
    dbprintf("usbfds %p %p %p %p %p\n", usbfds, 
            usbfds[0], usbfds[1], usbfds[2], usbfds[3]);
    nusbfds = 3;        /* Skip over listen fd at [0,1,2] */
    for (i = 0; usbfds[i] != NULL; i++) {
        dbprintf(" %lu: %p fd %d %04X\n", nusbfds, 
                usbfds[i], usbfds[i]->fd, usbfds[i]->events);
        Clients[nusbfds].fd = usbfds[i]->fd;
        Clients[nusbfds].events = usbfds[i]->events;
        Clients[nusbfds].revents = 0;
        nusbfds++;
    }
    nusbfds -= 3;  /* Adjust for skipping 0,1,2 */
    dbprintf("nusbfds %lu\n", nusbfds);
    memset(&timeout, 0, sizeof(timeout));
 //        initcm1Xa(initcm19abinary);
 
 
    PollTimeOut = -1;



    do_collect(Devh,ignorehistorique);
  


    syslog(LOG_NOTICE, "detaching TL500" );

    if (IntrOut_transfer) {
        r = libusb_cancel_transfer(IntrOut_transfer);
        if (r < 0)
            goto out_deinit;
    }

    if (IntrIn_transfer) {
        r = libusb_cancel_transfer(IntrIn_transfer);
        if (r < 0)
            goto out_deinit;
    }

    i = 100;
    while ((IntrOut_transfer || IntrIn_transfer) && i--)
        if (libusb_handle_events(NULL) < 0)
            break;

    if (Do_exit == 1)
        r = 0;
    else
        r = 1;

out_deinit:
    libusb_free_transfer(IntrIn_transfer);
    libusb_free_transfer(IntrOut_transfer);
/* out_release: */
    libusb_release_interface(Devh, 0);
out:
    libusb_close(Devh);
    if (Reattach) libusb_attach_kernel_driver(Devh, 0);
    libusb_exit(NULL);
    return r >= 0 ? r : -r;
}

static void printcopy(void)
{
    dbprintf("Copyright (C) 2016-2017 zdid.\n");
    dbprintf("\n");
    dbprintf("This program comes with NO WARRANTY.\n");
    dbprintf("You may redistribute copies of this program\n");
    dbprintf("under the terms of the GNU General Public License.\n");
    dbprintf("For more information about these matters, see the file named COPYING.\n");
    fflush(NULL);
}

int raw_data = 0;
int main(int argc, char *argv[])
{
    int rc, i;
    int foreground=0;
    int ignorehistorique=false;
    const char *urlfile = "url.txt"; /* ⭐ 19/08/2026, fichier de config transmis avec l'exécutable */
    dbprintf("tl500 demarrage");
    /* Initialize logging */
    openlog(DAEMON_NAME, LOG_PID, LOG_LOCAL5);
    syslog(LOG_NOTICE, "starting");
    
    //forcé pour ne pas etre en daemon
    foreground = 1;
 
    /* Process command line args */
    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-d") == 0)
           foreground = 1;
        else  if (strcmp(argv[i], "--ignorehistorique") == 0
		|| strcmp(argv[i], "-ih") == 0) {
	ignorehistorique = true;
        }
        else  if (strcmp(argv[i], "--version") == 0) {
            dbprintf("%s\n", "v_1");
            printcopy();
            exit(0);
        }
        else if (strcmp(argv[i], "--urlfile") == 0 && i + 1 < argc) {
            urlfile = argv[++i];
        }
       else {
            dbprintf("unknown option %s\n", argv[i]);
            exit(-1);
        }
    }

    /* Daemonize */
    if (!foreground) {
        rc = daemon(0, 0);
        dbprintf("daemon() => %d\n", rc);
    }

    read_url_config(urlfile); /* ⭐ 19/08/2026 */

    /* Do real work */
    rc = mydaemon(ignorehistorique);

    /* Finish up */
    syslog(LOG_NOTICE, "terminated");
    closelog();
    return rc;
}
