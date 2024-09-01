using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.Config.Schemas;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Extensions;

public static class EntityWithName_Overrides
{

    /// <summary>
    /// Sets the <see cref="NamedEntity.Entity_Name"/>, <see cref="NamedEntity.Entity_DisplayName"/>, and <see cref="BaseEntity.Entity_Enabled"/> properties 
    /// based on the provided <paramref name="overrides"/> or default functions.
    /// </summary>
    /// <typeparam name="TKey">The type of the key used in the dictionary of entities.</typeparam>
    /// <typeparam name="TEntity">The type of the entity in the dictionary, which must be a <see cref="NamedEntity"/>.</typeparam>
    /// <param name="entities">The dictionary of entities to update.</param>
    /// <param name="overrides">The overrides object that may contain specific override values for the entities.</param>
    /// <param name="DefaultNameFunc">A function that provides the default name for an entity based on the key and the entity itself.</param>
    /// <param name="DefaultDisplayNameFunc">A function that provides the default display name for an entity based on the key and the entity itself. If null, it defaults to <paramref name="DefaultNameFunc"/>.</param>
    /// <exception cref="ArgumentNullException">Thrown when <paramref name="DefaultNameFunc"/> is null.</exception>
    /// <exception cref="Exception">Thrown when unable to determine the entity ID or name, or if any other unexpected error occurs during processing.</exception>
    public static void SetEntityNameAndEnabled<TKey, TEntity>([DisallowNull] this Dictionary<TKey, TEntity> entities, [DisallowNull] Overrides overrides, [DisallowNull] Func<TKey, TEntity, string> DefaultNameFunc, [DisallowNull] Func<TKey, TEntity, string> DefaultDisplayNameFunc)
        where TKey : notnull
        where TEntity : notnull, NamedEntity
    {
        if (DefaultNameFunc is null)
            throw new ArgumentNullException(nameof(DefaultNameFunc));

        DefaultDisplayNameFunc ??= DefaultNameFunc;

        foreach (var (key, entity) in entities)
        {
            EntityOverride? entityOverride = (key, entity) switch
            {
                // We are adding + 1 to the outlet's key- because the PDU gives data 0-based. However, when the entities are viewed through
                // its UI, they are 1-based. This corrects that.
                (int k, Outlet o) => overrides.Outlets!.TryGetValue(k + 1, out var outletOverride) ? outletOverride : null,
                (string k, Device o) => overrides.Devices!.TryGetValue(k, out var outletOverride) ? outletOverride : null,
                (string k, Measurement o) => overrides.Measurements!.TryGetValue(o.Type, out var outletOverride) ? outletOverride : null,
                _ => null
            };

            // If overrides are defined, use those.
            if (entityOverride is not null && entity is Measurement m)
            {
                // Measurements inherits part of the parents name. aka, "outlet_1_power"
                entity.Entity_Name = Coalesce(entityOverride.ID, DefaultNameFunc?.Invoke(key, entity), entity.Entity_Name)?.FormatName() ?? throw new Exception("Unable to determine entity ID.");
                entity.Entity_DisplayName = Coalesce(entityOverride.Name, DefaultDisplayNameFunc?.Invoke(key, entity), entity.Entity_DisplayName) ?? throw new Exception("Unable to determine entity name.");
                entity.Entity_Enabled = entityOverride.Enabled; //Always default to enabled.
            }
            else if (entityOverride is not null)
            {
                entity.Entity_Name = Coalesce(entityOverride.ID, DefaultNameFunc?.Invoke(key, entity), entity.Entity_Name)?.FormatName() ?? throw new Exception("Unable to determine entity ID.");
                entity.Entity_DisplayName = Coalesce(entityOverride.Name, DefaultDisplayNameFunc?.Invoke(key, entity), entity.Entity_DisplayName) ?? throw new Exception("Unable to determine entity name.");
                entity.Entity_Enabled = entityOverride.Enabled; //Always default to enabled.
            }
            else // No overrides defined. Set defaults.
            {
                entity.Entity_Name = DefaultNameFunc!.Invoke(key, entity).FormatName();
                entity.Entity_DisplayName = DefaultDisplayNameFunc!.Invoke(key, entity);
                entity.Entity_Enabled = true;
            }
        }
    }

    /// <summary>
    /// Prune disabled items from dictionary.
    /// </summary>
    /// <typeparam name="TKey"></typeparam>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="entities"></param>
    public static void PruneDisabled<TKey, TEntity>([DisallowNull] this Dictionary<TKey, TEntity> entities)
     where TKey : notnull
     where TEntity : notnull, NamedEntity
    {
        var disabled = entities.Where(o => o.Value.Entity_Enabled == false).ToArray();

        foreach (var entity in disabled)
            entities.Remove(entity.Key);
    }

    /// <summary>
    /// Set a prefix for all contained entities. (This- is used to prefix measurements, with the parent's ID.)
    /// </summary>
    /// <typeparam name="TKey"></typeparam>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="entities"></param>
    /// <param name="Prefix"></param>
    public static void SetEntityNamePrefix<TKey, TEntity>([DisallowNull] this Dictionary<TKey, TEntity> entities, string Prefix)
    where TKey : notnull
    where TEntity : notnull, NamedEntity
    {
        foreach (var (_, entity) in entities)
            entity.Entity_Name = $"{Prefix}_{entity.Entity_Name}";
    }


    /// <summary>
    /// Sets all properties of <see cref="IMQTTKey"/>.
    /// </summary>
    /// <remarks>
    /// <see cref="IMQTTKey.Record_Key"/> is set to key from device.
    /// </remarks>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="Items"></param>
    /// <param name="Parent"></param>
    public static void SetParentAndIdentifier<TKey, TEntity>(this Dictionary<TKey, TEntity> Items, IMQTTKey Parent, [DisallowNull] Func<TKey, TEntity, string>? IdentifierFunc) where TEntity : BaseEntity
    {
        foreach (var (key, item) in Items)
        {
            string childKey = IdentifierFunc.Invoke(key, item);
            item.Record_Parent = Parent;
            item.Record_Key = childKey;
            item.Entity_Identifier = Parent.CreateChildIdentifier(childKey);
        }
    }

}