﻿using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.DummyDevices;

namespace rPDU2MQTT.Extensions;

public static class IMQTTKeyExtensions
{
    /// <summary>
    /// Recurses through a device's parents, and returns the full MQTT Topic Path..
    /// </summary>
    /// <param name="Device"></param>
    /// <returns></returns>
    public static string GetTopicPath(this IMQTTKey Device)
    {
        //Since- we are starting at the child level- we need to reverse the order.
        var paths = Device.GetMQTTPaths();
        return MQTTHelper.JoinPaths(paths);
    }

    /// <summary>
    /// Recurse upwards through a device's parents, returning the paths.
    /// </summary>
    /// <param name="Device"></param>
    /// <returns></returns>
    public static string[] GetMQTTPaths(this IMQTTKey Device)
    {
        //Since- we are starting at the child level- we need to reverse the order.
        return Device.getPaths().Reverse().ToArray();
    }

    private static IEnumerable<string> getPaths(this IMQTTKey Device)
    {
        yield return Device.Record_Key;

        IMQTTKey? parent = Device.Record_Parent;
        while (parent is not null)
        {
            yield return parent.Record_Key;

            // Go up to the next parent.
            parent = parent.Record_Parent;
        }
    }


    /// <summary>
    /// Returns a string, with the child identifier concat-ed to the parent's identifier.
    /// </summary>
    /// <param name="Device"></param>
    /// <param name="ChildIdentifier"></param>
    /// <returns></returns>
    public static string CreateChildIdentifier(this IMQTTKey Device, string ChildIdentifier)
        => $"{Device.Entity_Identifier}_{ChildIdentifier}";


    /// <summary>
    /// This attempts to create a "short" name for entities, only including values up to the first "real" parent.
    /// </summary>
    /// <param name="Device"></param>
    /// <returns></returns>
    public static string GetEntityName(this IMQTTKey Device)
    {
        string getObjectID(IMQTTKey? cur)
        {
            //If- the current device is null- just return the unique identifier.
            if (cur is null)
                return Device.Entity_Identifier;

            //If- this is a dummy entity used for organization, skip it, and recurse to the parent.
            if (cur is DummyEntity && cur.Record_Parent is not null)
                return getObjectID(cur.Record_Parent);

            if (cur is NamedEntityWithMeasurements cd)
                return $"{cd.Entity_Name}_{Device.Record_Key}";

            //Recurse up another level.
            return getObjectID(cur.Record_Parent);
        }

        return getObjectID(Device);
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
