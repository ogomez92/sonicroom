using System;
using System.Collections.Generic;

namespace SonicRoom.Windows.Transport;

/// <summary>
/// Hands out the send transport's preallocated audio m-line slots. A stopped producer's slot goes
/// back to the pool and the LOWEST free slot is reused first, so a call can start and stop
/// shares / files / extra mics indefinitely instead of running out after the first 16.
/// </summary>
public sealed class ProducerSlotPool
{
    private readonly SortedSet<int> _free = new();
    private readonly object _lock = new();

    public ProducerSlotPool(int count)
    {
        for (var i = 0; i < count; i++) _free.Add(i);
        Count = count;
    }

    public int Count { get; }

    /// <summary>Take the lowest free slot; throws when every slot is in use.</summary>
    public int Take()
    {
        lock (_lock)
        {
            if (_free.Count == 0)
                throw new InvalidOperationException($"This call already uses all {Count} outgoing audio slots.");
            var slot = _free.Min;
            _free.Remove(slot);
            return slot;
        }
    }

    /// <summary>Return a slot to the pool. Out-of-range or already-free slots are ignored.</summary>
    public void Release(int slot)
    {
        if (slot < 0 || slot >= Count) return;
        lock (_lock) _free.Add(slot);
    }
}
