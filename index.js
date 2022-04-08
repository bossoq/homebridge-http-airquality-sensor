"use strict";

let Service, Characteristic, api;

const _http_base = require("homebridge-http-base");
const http = _http_base.http;
const configParser = _http_base.configParser;
const notifications = _http_base.notifications;
const MQTTClient = _http_base.MQTTClient;
const Cache = _http_base.Cache;
const utils = _http_base.utils;

const packageJSON = require("./package.json");

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  api = homebridge;

  homebridge.registerAccessory(
    "homebridge-http-airquality-sensor",
    "HTTP-AIRQUALITY-SENSOR",
    HTTP_AIRQUALITY
  );
};

function HTTP_AIRQUALITY(log, config) {
  this.log = log;
  this.name = config.name;
  this.debug = config.debug || false;

  if (config.getUrl) {
    try {
      this.getUrl = configParser.parseUrlProperty(config.getUrl);
    } catch (error) {
      this.log.warn("Error occurred while parsing 'getUrl': " + error.message);
      this.log.warn("Aborting...");
      return;
    }
  } else {
    this.log.warn("Property 'getUrl' is required!");
    this.log.warn("Aborting...");
    return;
  }

  this.levels = {
    0: Characteristic.AirQuality.EXCELLENT,
    1: Characteristic.AirQuality.GOOD,
    2: Characteristic.AirQuality.FAIR,
    3: Characteristic.AirQuality.INFERIOR,
    4: Characteristic.AirQuality.POOR,
  };

  this.characteristics = {
    air_quality: Characteristic.AirQuality,
    pm25: Characteristic.PM2_5Density,
    pm10: Characteristic.PM10Density,
  };

  this.statusCache = new Cache(config.statusCache, 0);
  this.air_quality = Characteristic.AirQuality.UNKNOWN;
  this.pm25 = 0;
  this.pm10 = 0;

  this.homebridgeService = new Service.AirQualitySensor(this.name);
  for (const attr in this.characteristics) {
    this.homebridgeService
      .getCharacteristic(this.characteristics[attr])
      .on("get", (callback) => {
        this.getState(callback, attr);
      });
  }

  /** @namespace config.notificationPassword */
  /** @namespace config.notificationID */
  notifications.enqueueNotificationRegistrationIfDefined(
    api,
    log,
    config.notificationID,
    config.notificationPassword,
    this.handleNotification.bind(this)
  );

  /** @namespace config.mqtt */
  if (config.mqtt) {
    let options;
    try {
      options = configParser.parseMQTTOptions(config.mqtt);
    } catch (error) {
      this.log.error(
        "Error occurred while parsing MQTT property: " + error.message
      );
      this.log.error("MQTT will not be enabled!");
    }

    if (options) {
      try {
        this.mqttClient = new MQTTClient(
          this.homebridgeService,
          options,
          this.log
        );
        this.mqttClient.connect();
      } catch (error) {
        this.log.error("Error occurred creating MQTT client: " + error.message);
      }
    }
  }
}

HTTP_AIRQUALITY.prototype = {
  identify: function (callback) {
    this.log("Identify requested!");
    callback();
  },

  getServices: function () {
    if (!this.homebridgeService) return [];

    const informationService = new Service.AccessoryInformation();

    informationService
      .setCharacteristic(Characteristic.Manufacturer, "bossoq")
      .setCharacteristic(Characteristic.Model, "HTTP AirQuality Sensor")
      .setCharacteristic(Characteristic.SerialNumber, "TS01")
      .setCharacteristic(Characteristic.FirmwareRevision, packageJSON.version);

    return [informationService, this.homebridgeService];
  },

  handleNotification: function (body) {
    const characteristic = utils.getCharacteristic(
      this.homebridgeService,
      body.characteristic
    );
    if (!characteristic) {
      this.log(
        "Encountered unknown characteristic when handling notification (or characteristic which wasn't added to the service): " +
          body.characteristic
      );
      return;
    }

    const value = parseInt(body.value);
    let updatedValue = 0;
    if (body.characteristic === "PM2_5Density") {
      this.pm25 = !isNaN(value) && value;
      updatedValue = this.pm25;
    } else if (body.characteristic === "PM10Density") {
      this.pm10 = !isNaN(value) && value;
      updatedValue = this.pm10;
    } else if (body.characteristic === "AirQuality") {
      this.air_quality =
        this.levels[value] || Characteristic.AirQuality.UNKNOWN;
      updatedValue = this.air_quality;
    }

    if (this.debug)
      this.log(
        "Updating '" +
          body.characteristic +
          "' to new value: " +
          this.air_quality
      );
    characteristic.updateValue(updatedValue);
  },

  getState: function (callback, characteristic) {
    if (!this.statusCache.shouldQuery()) {
      let value = null;
      if (characteristic === "PM2_5Density") {
        value = this.pm25;
      } else if (characteristic === "PM10Density") {
        value = this.pm10;
      } else if (characteristic === "AirQuality") {
        value = this.air_quality;
      }
      if (this.debug)
        this.log(
          `getState() returning cached value ${value}${
            this.statusCache.isInfinite() ? " (infinite cache)" : ""
          }`
        );

      callback(null, value);
      return;
    }

    http.httpRequest(this.getUrl, (error, response, body) => {
      if (this.pullTimer) this.pullTimer.resetTimer();

      if (error) {
        this.log("getState() failed: %s", error.message);
        callback(error);
      } else if (!http.isHttpSuccessCode(response.statusCode)) {
        this.log("getState() returned http error: %s", response.statusCode);
        callback(new Error("Got http error code " + response.statusCode));
      } else {
        const data = JSON.parse(body);
        this.pm25 = !isNaN(parseInt(data.pm25)) && parseInt(data.pm25);
        this.pm10 = !isNaN(parseInt(data.pm10)) && parseInt(data.pm10);
        this.air_quality =
          this.levels[parseInt(data.aqi)] || Characteristic.AirQuality.UNKNOWN;

        if (this.debug) {
          this.log(data);
          this.log("PM2.5 is currently at %s", this.pm25);
          this.log("PM10 is currently at %s", this.pm10);
          this.log("AirQuality is currently at %s", this.air_quality);
        }
        let retVal = null;
        if (characteristic === "PM2_5Density") {
          retVal = this.pm25;
        } else if (characteristic === "PM10Density") {
          retVal = this.pm10;
        } else if (characteristic === "AirQuality") {
          retVal = this.air_quality;
        }

        this.statusCache.queried();
        callback(null, retVal);
      }
    });
  },
};
