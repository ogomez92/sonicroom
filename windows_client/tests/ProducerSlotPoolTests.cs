using System;
using SonicRoom.Windows.Transport;
using Xunit;

namespace SonicRoom.Windows.Tests;

/// <summary>
/// The send transport's m-line slots must be reusable: a call that starts and stops shares,
/// files and extra mics more than 15 times must not run out of outgoing audio slots.
/// </summary>
public sealed class ProducerSlotPoolTests
{
    [Fact]
    public void HandsOutSlotsInOrderAndThrowsWhenFull()
    {
        var pool = new ProducerSlotPool(3);
        Assert.Equal(0, pool.Take());
        Assert.Equal(1, pool.Take());
        Assert.Equal(2, pool.Take());
        Assert.Throws<InvalidOperationException>(() => pool.Take());
    }

    [Fact]
    public void ReleasedSlotIsReusedLowestFirst()
    {
        var pool = new ProducerSlotPool(4);
        for (var i = 0; i < 4; i++) pool.Take();
        pool.Release(2);
        pool.Release(1);
        Assert.Equal(1, pool.Take());
        Assert.Equal(2, pool.Take());
        Assert.Throws<InvalidOperationException>(() => pool.Take());
    }

    [Fact]
    public void ManyStartStopCyclesNeverExhaustThePool()
    {
        // Slot 0 is the voice producer, held for the whole call.
        var pool = new ProducerSlotPool(16);
        Assert.Equal(0, pool.Take());
        for (var cycle = 0; cycle < 100; cycle++)
        {
            var share = pool.Take();
            Assert.Equal(1, share);
            pool.Release(share);
        }
    }

    [Fact]
    public void DoubleOrOutOfRangeReleaseDoesNotInventSlots()
    {
        var pool = new ProducerSlotPool(2);
        var a = pool.Take();
        pool.Take();
        pool.Release(a);
        pool.Release(a);
        pool.Release(-1);
        pool.Release(7);
        Assert.Equal(a, pool.Take());
        Assert.Throws<InvalidOperationException>(() => pool.Take());
    }
}
