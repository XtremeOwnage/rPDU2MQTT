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
                (int k, Outlet o) => overrides.Outlets!.TryGetValue(k, out var outletOverride) ? outletOverride : null,
                (string k, Device o) => overrides.Devices!.TryGetValue(k, out var outletOverride) ? outletOverride : null,
                (string k, Measurement o) => overrides.Measurements!.TryGetValue(o.Type, out var outletOverride) ? outletOverride : null,
                _ => null
            };

            // If overrides are defined, use those.
            if (entityOverride is not null)
            {
                entity.Entity_Name = Coalesce(entityOverride.ID, DefaultNameFunc?.Invoke(key, entity), entity.Entity_Name)?.FormatName() ?? throw new Exception("Unable to determine entity ID.");
                entity.Entity_DisplayName = Coalesce(entityOverride.Name, DefaultDisplayNameFunc?.Invoke(key, entity), entity.Entity_DisplayName) ?? throw new Exception("Unable to determine entity name.");
                entity.Entity_Enabled = entityOverride.Enabled; //Always default to enabled.
            }
            else // No overrides defined. Set defaults.
            {
                entity.Entity_Name = DefaultNameFunc!.Invoke(key, entity);
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
    /// Sets <see cref="IMQTTKey.Record_Key"/> for all items in dictionary based on <paramref name="ValueFunc"/>
    /// </summary>
    /// <typeparam name="TKey"></typeparam>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="entities"></param>
    /// <param name="ValueFunc"></param>
    public static void SetRecordKey<TKey, TEntity>([DisallowNull] this Dictionary<TKey, TEntity> entities, [DisallowNull] Func<TKey, TEntity, string> ValueFunc)
         where TKey : notnull
         where TEntity : notnull, NamedEntity
    {
        foreach (var (key, entity) in entities)
            entity.Record_Key = ValueFunc!.Invoke(key, entity);
    }


    private static bool caseInsensitiveLookup<TValue>(this Dictionary<string, TValue> Dictionary, string Key, out TValue Result, TValue DefaultValue)
    {
        var match = Dictionary.Keys.FirstOrDefault(o => string.Equals(o, Key, StringComparison.OrdinalIgnoreCase));
        if (match is null)
        {
            Result = DefaultValue;
            return false;
        }

        Result = Dictionary[match];

        if (Result is null)
            return false;
        if (Result is string s)
            return !string.IsNullOrWhiteSpace(s);
        return Result is not null;
    }

    /// <summary>
    /// Sets all properties of <see cref="IMQTTKey"/>.
    /// </summary>
    /// <remarks>
    /// <see cref="IMQTTKey.Record_Key"/> is set to key from device.
    /// </remarks>
    /// <typeparam name="T"></typeparam>
    /// <param name="Items"></param>
    /// <param name="Parent"></param>
    public static void SetParentAndIdentifier<T>(this Dictionary<string, T> Items, IMQTTKey Parent) where T : BaseEntity
    {
        foreach (var (key, item) in Items)
        {
            item.Record_Parent = Parent;
            item.Record_Key = key;
            item.Entity_Identifier = Parent.CreateChildIdentifier(key);
        }
    }

}