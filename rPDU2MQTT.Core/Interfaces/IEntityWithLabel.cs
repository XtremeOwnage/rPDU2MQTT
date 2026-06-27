namespace rPDU2MQTT.Interfaces
{
    public interface IEntityWithLabel
    {
        /// <summary>
        /// Label for this entity.
        /// </summary>
        public string Label { get; set; }
    }
}
