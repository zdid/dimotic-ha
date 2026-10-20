# Service ups-hat-e — installation (UPS HAT (E), Waveshare, I2C 0x2D)

Spec : `specs/current/conception-ups-hat-e_specs_v1.0.md`. Lecture seule : ne jamais écrire dans le registre 0x01 (0x55 éteint la carte).

```bash
sudo apt-get install -y i2c-tools python3-smbus python3-paho-mqtt
# I2C actif (Raspberry Pi) : sudo cp -p /boot/firmware/config.txt /boot/firmware/config.txt.bak-$(date +%Y%m%d); décommenter dtparam=i2c_arm=on
#   à chaud : sudo modprobe i2c-dev && sudo dtparam i2c_arm=on     (permanent : echo i2c-dev | sudo tee /etc/modules-load.d/ups-hat-e.conf)
# Orange Pi 4 Pro : sudo orangepi-config -> System -> Hardware -> i2c0, puis redémarrer ; le bus Linux se lit avec i2cdetect -l
sudo i2cdetect -y 1                      # l'adresse 2d doit apparaître (autre bus : UPS_I2C_BUS)
sudo mkdir -p /opt/ups-hat-e && sudo cp ups_hat_e.py /opt/ups-hat-e/ && sudo cp ups-hat-e.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ups-hat-e.service
```

Réglages (variables d'environnement du service) : `UPS_I2C_BUS` (1), `UPS_MQTT_HOST` (127.0.0.1), `UPS_PERIODE_S` (10), `UPS_NOM_APPAREIL` (`ups---ha2--infra`), `UPS_ID` (`ups_hat_e_ha2`, à changer par machine).
