using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.basePDU;

namespace rPDU2MQTT.Helpers;

/// <summary>
/// Defines default names for various entity types.
/// </summary>
public static class DefaultNames
{
    public static string UseEntityName<TKey, TEntity>(TKey key, TEntity entity) where TEntity : EntityWithNameAndLabel => entity.Name;
    public static string UseEntityLabel<TKey, TEntity>(TKey key, TEntity entity) where TEntity : EntityWithNameAndLabel => entity.Label ?? entity.Name;
    public static string UseMeasurementType<TKey, TEntity>(TKey key, TEntity entity) where TEntity : Measurement => entity.Type;
}
