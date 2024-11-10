namespace rPDU2MQTT.Interfaces;

public interface IDictionaryKey<TKeyType>
{
    /// <summary>
    /// This is the key which was assigned to this member.
    /// </summary>
    /// <remarks>
    /// This value is populated by <see cref="rPDU2MQTT.Models.Converters.DictionaryToListConverter{TObject, TKey}"/>. 
    /// </remarks>
    TKeyType Key { get; set; }
}
