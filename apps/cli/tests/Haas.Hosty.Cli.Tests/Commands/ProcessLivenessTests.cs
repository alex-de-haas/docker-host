using Haas.Hosty.Cli.Commands;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class ProcessLivenessTests
{
    [Fact]
    public void IsAlive_CurrentProcess_ReturnsTrue()
        => Assert.True(ProcessLiveness.IsAlive(Environment.ProcessId));

    [Fact]
    public void IsAlive_NonExistentProcess_ReturnsFalse()
        => Assert.False(ProcessLiveness.IsAlive(int.MaxValue - 1));

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void IsAlive_NonPositiveId_ReturnsFalse(int processId)
        => Assert.False(ProcessLiveness.IsAlive(processId));

    [Fact]
    public async Task WaitForExitAsync_AlreadyDeadProcess_ReturnsTrue()
        => Assert.True(await ProcessLiveness.WaitForExitAsync(int.MaxValue - 1, TimeSpan.FromSeconds(2)));

    [Fact]
    public async Task WaitForExitAsync_NonPositiveId_ReturnsTrue()
        => Assert.True(await ProcessLiveness.WaitForExitAsync(0, TimeSpan.FromSeconds(2)));
}
