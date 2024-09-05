using System.Collections.Concurrent;

namespace rPDU2MQTT.Classes;

/// <summary>
/// This class, exists to watch tasks until completion. Non-async code, which needs to execute a task, just passes the task off to this class.
/// </summary>
public static class TaskManager
{
    private static readonly ConcurrentBag<Task> taskBag = new ConcurrentBag<Task>();

    public static void AddTask(Action task)
    {
        Task newTask = Task.Run(task);
        taskBag.Add(newTask);
    }

    public static void AddTask(Task task)
    {
        taskBag.Add(task);
    }

    public static void WaitForAllTasks()
    {
        foreach (var task in taskBag)
        {
            task.Wait();
        }

        taskBag.Clear();  // ConcurrentBag doesn't have a clear method, but assigning a new one is equivalent to clearing.
    }
}
