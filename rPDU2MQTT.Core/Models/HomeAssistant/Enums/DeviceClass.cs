using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.HomeAssistant.Enums;
using System.Text.Json.Serialization;

/// <summary>
/// Device class for sensors in Home Assistant.
/// </summary>
public enum DeviceClass
{
    [JsonPropertyName("")]
    Unknown = 0,
    /// <summary>
    /// Date.
    /// Unit of measurement: None
    /// ISO8601 format: https://en.wikipedia.org/wiki/ISO_8601
    /// </summary>
    [JsonPropertyName("date")]
    Date,

    /// <summary>
    /// Enumeration.
    /// Provides a fixed list of options the state of the sensor can be in.
    /// Unit of measurement: None
    /// </summary>
    [JsonPropertyName("enum")]
    Enum,

    /// <summary>
    /// Timestamp.
    /// Unit of measurement: None
    /// ISO8601 format: https://en.wikipedia.org/wiki/ISO_8601
    /// </summary>
    [JsonPropertyName("timestamp")]
    Timestamp,

    /// <summary>
    /// Apparent power.
    /// Unit of measurement: VA
    /// </summary>
    [JsonPropertyName("apparent_power")]
    ApparentPower,

    /// <summary>
    /// Air Quality Index.
    /// Unit of measurement: None
    /// </summary>
    [JsonPropertyName("aqi")]
    AQI,

    /// <summary>
    /// Atmospheric pressure.
    /// Unit of measurement: UnitOfPressure units
    /// </summary>
    [JsonPropertyName("atmospheric_pressure")]
    AtmosphericPressure,

    /// <summary>
    /// Percentage of battery that is left.
    /// Unit of measurement: %
    /// </summary>
    [JsonPropertyName("battery")]
    Battery,

    /// <summary>
    /// Carbon Monoxide gas concentration.
    /// Unit of measurement: ppm (parts per million)
    /// </summary>
    [JsonPropertyName("carbon_monoxide")]
    CarbonMonoxide,

    /// <summary>
    /// Carbon Dioxide gas concentration.
    /// Unit of measurement: ppm (parts per million)
    /// </summary>
    [JsonPropertyName("carbon_dioxide")]
    CarbonDioxide,

    /// <summary>
    /// Conductivity.
    /// Unit of measurement: S/cm, mS/cm, µS/cm
    /// </summary>
    [JsonPropertyName("conductivity")]
    Conductivity,

    /// <summary>
    /// Current.
    /// Unit of measurement: A, mA
    /// </summary>
    [JsonPropertyName("current")]
    Current,

    /// <summary>
    /// Data rate.
    /// Unit of measurement: UnitOfDataRate
    /// </summary>
    [JsonPropertyName("data_rate")]
    DataRate,

    /// <summary>
    /// Data size.
    /// Unit of measurement: UnitOfInformation
    /// </summary>
    [JsonPropertyName("data_size")]
    DataSize,

    /// <summary>
    /// Generic distance.
    /// Unit of measurement: LENGTH_* units
    /// - SI / metric: mm, cm, m, km
    /// - USCS / imperial: in, ft, yd, mi
    /// </summary>
    [JsonPropertyName("distance")]
    Distance,

    /// <summary>
    /// Fixed duration.
    /// Unit of measurement: d, h, min, s, ms
    /// </summary>
    [JsonPropertyName("duration")]
    Duration,

    /// <summary>
    /// Energy.
    /// Unit of measurement: Wh, kWh, MWh, MJ, GJ
    /// </summary>
    [JsonPropertyName("energy")]
    Energy,

    /// <summary>
    /// Stored energy.
    /// Unit of measurement: Wh, kWh, MWh, MJ, GJ
    /// </summary>
    [JsonPropertyName("energy_storage")]
    EnergyStorage,

    /// <summary>
    /// Frequency.
    /// Unit of measurement: Hz, kHz, MHz, GHz
    /// </summary>
    [JsonPropertyName("frequency")]
    Frequency,

    /// <summary>
    /// Gas.
    /// Unit of measurement:
    /// - SI / metric: m³
    /// - USCS / imperial: ft³, CCF
    /// </summary>
    [JsonPropertyName("gas")]
    Gas,

    /// <summary>
    /// Relative humidity.
    /// Unit of measurement: %
    /// </summary>
    [JsonPropertyName("humidity")]
    Humidity,

    /// <summary>
    /// Illuminance.
    /// Unit of measurement: lx
    /// </summary>
    [JsonPropertyName("illuminance")]
    Illuminance,

    /// <summary>
    /// Irradiance.
    /// Unit of measurement:
    /// - SI / metric: W/m²
    /// - USCS / imperial: BTU/(h⋅ft²)
    /// </summary>
    [JsonPropertyName("irradiance")]
    Irradiance,

    /// <summary>
    /// Moisture.
    /// Unit of measurement: %
    /// </summary>
    [JsonPropertyName("moisture")]
    Moisture,

    /// <summary>
    /// Amount of money.
    /// Unit of measurement: ISO4217 currency code
    /// </summary>
    [JsonPropertyName("monetary")]
    Monetary,

    /// <summary>
    /// Amount of NO2.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("nitrogen_dioxide")]
    NitrogenDioxide,

    /// <summary>
    /// Amount of NO.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("nitrogen_monoxide")]
    NitrogenMonoxide,

    /// <summary>
    /// Amount of N2O.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("nitrous_oxide")]
    NitrousOxide,

    /// <summary>
    /// Amount of O3.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("ozone")]
    Ozone,

    /// <summary>
    /// Potential hydrogen (acidity/alkalinity).
    /// Unit of measurement: Unitless
    /// </summary>
    [JsonPropertyName("ph")]
    PH,

    /// <summary>
    /// Particulate matter <= 1 μm.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("pm1")]
    PM1,

    /// <summary>
    /// Particulate matter <= 10 μm.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("pm10")]
    PM10,

    /// <summary>
    /// Particulate matter <= 2.5 μm.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("pm25")]
    PM25,

    /// <summary>
    /// Power factor.
    /// Unit of measurement: %, None
    /// </summary>
    [JsonPropertyName("power_factor")]
    PowerFactor,

    /// <summary>
    /// Power.
    /// Unit of measurement: W, kW
    /// </summary>
    [JsonPropertyName("power")]
    Power,

    /// <summary>
    /// Accumulated precipitation.
    /// Unit of measurement: UnitOfPrecipitationDepth
    /// - SI / metric: cm, mm
    /// - USCS / imperial: in
    /// </summary>
    [JsonPropertyName("precipitation")]
    Precipitation,

    /// <summary>
    /// Precipitation intensity.
    /// Unit of measurement: UnitOfVolumetricFlux
    /// - SI / metric: mm/d, mm/h
    /// - USCS / imperial: in/d, in/h
    /// </summary>
    [JsonPropertyName("precipitation_intensity")]
    PrecipitationIntensity,

    /// <summary>
    /// Pressure.
    /// Unit of measurement:
    /// - mbar, cbar, bar
    /// - Pa, hPa, kPa
    /// - inHg
    /// - psi
    /// </summary>
    [JsonPropertyName("pressure")]
    Pressure,

    /// <summary>
    /// Reactive power.
    /// Unit of measurement: var
    /// </summary>
    [JsonPropertyName("reactive_power")]
    ReactivePower,

    /// <summary>
    /// Signal strength.
    /// Unit of measurement: dB, dBm
    /// </summary>
    [JsonPropertyName("signal_strength")]
    SignalStrength,

    /// <summary>
    /// Sound pressure.
    /// Unit of measurement: dB, dBA
    /// </summary>
    [JsonPropertyName("sound_pressure")]
    SoundPressure,

    /// <summary>
    /// Generic speed.
    /// Unit of measurement: SPEED_* units or UnitOfVolumetricFlux
    /// - SI / metric: mm/d, mm/h, m/s, km/h
    /// - USCS / imperial: in/d, in/h, ft/s, mph
    /// - Nautical: kn
    /// - Beaufort: Beaufort
    /// </summary>
    [JsonPropertyName("speed")]
    Speed,

    /// <summary>
    /// Amount of SO2.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("sulphur_dioxide")]
    SulphurDioxide,

    /// <summary>
    /// Temperature.
    /// Unit of measurement: °C, °F, K
    /// </summary>
    [JsonPropertyName("temperature")]
    Temperature,

    /// <summary>
    /// Amount of VOC.
    /// Unit of measurement: µg/m³
    /// </summary>
    [JsonPropertyName("volatile_organic_compounds")]
    VolatileOrganicCompounds,

    /// <summary>
    /// Ratio of VOC.
    /// Unit of measurement: ppm, ppb
    /// </summary>
    [JsonPropertyName("volatile_organic_compounds_parts")]
    VolatileOrganicCompoundsParts,

    /// <summary>
    /// Voltage.
    /// Unit of measurement: V, mV
    /// </summary>
    [JsonPropertyName("voltage")]
    Voltage,

    /// <summary>
    /// Generic volume.
    /// Unit of measurement: VOLUME_* units
    /// - SI / metric: mL, L, m³
    /// - USCS / imperial: ft³, CCF, fl. oz., gal
    /// </summary>
    [JsonPropertyName("volume")]
    Volume,

    /// <summary>
    /// Generic stored volume.
    /// Use this device class for sensors measuring stored volume, for example the amount of fuel in a fuel tank.
    /// Unit of measurement: VOLUME_* units
    /// - SI / metric: mL, L, m³
    /// - USCS / imperial: ft³, CCF, fl. oz., gal
    /// </summary>
    [JsonPropertyName("volume_storage")]
    VolumeStorage,

    /// <summary>
    /// Generic flow rate.
    /// Unit of measurement: UnitOfVolumeFlowRate
    /// - SI / metric: m³/h, L/min
    /// - USCS / imperial: ft³/min, gal/min
    /// </summary>
    [JsonPropertyName("volume_flow_rate")]
    VolumeFlowRate,

    /// <summary>
    /// Water.
    /// Unit of measurement:
    /// - SI / metric: m³, L
    /// - USCS / imperial: ft³, CCF, gal
    /// </summary>
    [JsonPropertyName("water")]
    Water,

    /// <summary>
    /// Generic weight, represents a measurement of an object's mass.
    /// Weight is used instead of mass to fit with everyday language.
    /// Unit of measurement: MASS_* units
    /// - SI / metric: µg, mg, g, kg
    /// - USCS / imperial: oz, lb
    /// </summary>
    [JsonPropertyName("weight")]
    Weight,

    /// <summary>
    /// Wind speed.
    /// Unit of measurement: SPEED_* units
    /// - SI / metric: m/s, km/h
    /// - USCS / imperial: ft/s, mph
    /// - Nautical: kn
    /// - Beaufort: Beaufort
    /// </summary>
    [JsonPropertyName("wind_speed")]
    WindSpeed
}
