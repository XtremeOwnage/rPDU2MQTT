using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.Config.Schemas;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Models.PDU.OneView;
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
    public static void SetEntityNameAndEnabled<TEntity>(
        [DisallowNull] this List<TEntity> entities
        , [DisallowNull] Overrides overrides
        , [DisallowNull] Func<TEntity, string> DefaultNameFunc
        , [DisallowNull] Func<TEntity, string> DefaultDisplayNameFunc)
        where TEntity : notnull, NamedEntity
    {
        if (DefaultNameFunc is null)
            throw new ArgumentNullException(nameof(DefaultNameFunc));

        DefaultDisplayNameFunc ??= DefaultNameFunc;

        foreach (var entity in entities)
        {
            var d = entity.TryGetDevice();

            EntityOverride? entityOverride = entity switch
            {
                // We are adding + 1 to the outlet's key- because the PDU gives data 0-based. However, when the entities are viewed through
                // its UI, they are 1-based. This corrects that.
                Outlet o => o.TryGetOverride(overrides),
                Device o => o.TryGetOverride(overrides),
                Measurement o => overrides.Measurements.TryGetValue(o.Type, out var outletOverride) ? outletOverride : null,
                GroupMeasurement o => overrides.GroupOverrides.Measurements.TryGetValue(o.Type, out var outletOverride) ? outletOverride : null,
                OneViewGroup o => o.TryGetOverride(overrides),
                _ => null
            };


            if (entityOverride is not null)
            {
                entity.Entity_Name = Coalesce(entityOverride.ID, DefaultNameFunc?.Invoke(entity), entity.Entity_Name)?.FormatName() ?? throw new Exception("Unable to determine entity ID.");
                entity.Entity_DisplayName = Coalesce(entityOverride.Name, DefaultDisplayNameFunc?.Invoke(entity), entity.Entity_DisplayName) ?? throw new Exception("Unable to determine entity name.");
                entity.Entity_Enabled = entityOverride.Enabled; //Always default to enabled.
            }
            else // No overrides defined. Set defaults.
            {
                entity.Entity_Name = DefaultNameFunc!.Invoke(entity).FormatName();
                entity.Entity_DisplayName = DefaultDisplayNameFunc!.Invoke(entity);
                entity.Entity_Enabled = true;
            }
        }
    }

    /// <summary>
    /// Prune disabled items from dictionary.
    /// </summary>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="entities"></param>
    public static void PruneDisabled<TEntity>([DisallowNull] this List<TEntity> entities)
     where TEntity : notnull, NamedEntity => entities.RemoveAll(o => o.Entity_Enabled == false);


    /// <summary>
    /// Set a prefix for all contained entities. (This- is used to prefix measurements, with the parent's ID.)
    /// </summary>
    /// <typeparam name="TKey"></typeparam>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="entities"></param>
    /// <param name="Prefix"></param>
    public static void SetEntityNamePrefix<TEntity>([DisallowNull] this List<TEntity> entities, string Prefix)
    where TEntity : notnull, NamedEntity => entities.ForEach(o => o.Entity_Name = $"{Prefix}_{o.Entity_Name}");



    /// <summary>
    /// Sets all properties of <see cref="IMQTTKey"/>.
    /// </summary>
    /// <remarks>
    /// <see cref="IMQTTKey.Record_Key"/> is set to key from device.
    /// </remarks>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="Items"></param>
    /// <param name="Parent"></param>
    public static void SetParentAndIdentifier<TEntity>(this List<TEntity> Items, IMQTTKey Parent, [DisallowNull] Func<TEntity, string>? IdentifierFunc)
        where TEntity : BaseEntity
    {
        foreach (var item in Items)
        {
            string childKey = IdentifierFunc.Invoke(item);
            item.Record_Parent = Parent;
            item.Record_Key = childKey;
            item.Entity_Identifier = Parent.CreateChildIdentifier(childKey);
        }
    }

    /// <summary>
    /// Try and resolve an Entities' parent device.
    /// </summary>
    /// <typeparam name="TEntity"></typeparam>
    /// <param name="Entity"></param>
    /// <returns></returns>
    public static Device? TryGetDevice<TEntity>(this TEntity Entity) where TEntity : IMQTTKey
    {
        if (Entity is Device device)
            return device;

        if (Entity.Record_Parent is not null)
            return TryGetDevice(Entity.Record_Parent);

        // No device?
        return null;
    }

    /// <summary>
    /// Try and resolve overrides for an outlet.
    /// </summary>
    /// <param name="pair"></param>
    /// <param name="overrides"></param>
    /// <returns></returns>
    public static EntityOverride? TryGetOverride(this Outlet Outlet, Overrides overrides)
    {
        var device = Outlet.TryGetDevice();
        if (device is not null)
        {
            var deviceOverrides = device.TryGetOverride(overrides);
            if (deviceOverrides is not null && deviceOverrides.Outlets.TryGetValue(Outlet.Key + 1, out var outletOverride))
                return outletOverride;
        }

        return null;
    }

    /// <summary>
    /// Try and resolve overrides for a device.
    /// </summary>
    /// <param name="device"></param>
    /// <param name="overrides"></param>
    /// <returns></returns>
    public static DeviceOverride? TryGetOverride(this Device Device, Overrides overrides)
    {
        if (overrides.Devices.TryGetValue(Device.Key, out var outletOverride))
            return outletOverride;

        return null;
    }

    /// <summary>
    /// Try and resolve overrides for a Oneview Group.
    /// </summary>
    /// <param name="Group"></param>
    /// <param name="overrides"></param>
    /// <returns></returns>
    public static EntityOverride? TryGetOverride(this OneViewGroup Group, Overrides overrides)
    {
        // Match based on the user defined label.
        if (overrides.GroupOverrides.Overrides.TryGetValue(Group.Label, out var r3))
            return r3;

        // First- try to match based on the ID.
        if (overrides.GroupOverrides.Overrides.TryGetValue(Group.Key, out var r1))
            return r1;

        // Next- try to match based on the name.
        if (overrides.GroupOverrides.Overrides.TryGetValue(Group.Name, out var r2))
            return r2;



        return null;
    }

}