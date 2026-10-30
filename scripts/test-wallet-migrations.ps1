param()
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$clusterRoot = Join-Path $temporaryRoot ('fw9-wallet-migrations-' + [guid]::NewGuid().ToString('N'))
$clusterData = Join-Path $clusterRoot 'data'
$clusterLog = Join-Path $clusterRoot 'postgres.log'
$clusterStarted = $false
$testPort = $null

function Invoke-CheckedNative {
    param([string]$Executable, [string[]]$Arguments, [switch]$ExpectFailure)
    # Redirect to files, not a captured PowerShell pipeline: postgres descendants
    # can inherit pipeline handles and keep pg_ctl's captured output open.
    # Start-Process -Wait waits for descendants on Windows; WaitForExit waits only
    # for the command itself so a background PostgreSQL server can remain alive.
    $outputToken = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $clusterRoot ($outputToken + '.stdout')
    $stderrPath = Join-Path $clusterRoot ($outputToken + '.stderr')
    $quotedArguments = foreach ($nativeArgument in $Arguments) {
        $escapedArgument = [regex]::Replace($nativeArgument, '(\\*)"', '$1$1\"')
        $escapedArgument = [regex]::Replace($escapedArgument, '(\\+)$', '$1$1')
        '"' + $escapedArgument + '"'
    }
    $executablePath = (Get-Command $Executable -ErrorAction Stop).Source
    $nativeProcess = Start-Process -FilePath $executablePath -ArgumentList ($quotedArguments -join ' ') -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $null = $nativeProcess.Handle
    if (-not $nativeProcess.WaitForExit(120000)) {
        $nativeProcess.Kill()
        throw ('Native command timed out: ' + $Executable)
    }
    $commandExitCode = $nativeProcess.ExitCode
    $commandOutput = @(Get-Content -LiteralPath $stdoutPath)
    $commandOutput += @(Get-Content -LiteralPath $stderrPath)
    if ($ExpectFailure) {
        if ($commandExitCode -eq 0) { throw 'A negative migration test unexpectedly succeeded' }
        return
    }
    if ($commandExitCode -ne 0) {
        throw ('Native command failed: ' + $Executable + ' ' + ($Arguments -join ' ') + [Environment]::NewLine + ($commandOutput -join [Environment]::NewLine))
    }
}

function Invoke-TestSql {
    param([string]$Database, [string]$File, [string]$Sql, [switch]$ExpectFailure)
    $psqlArguments = @('-X', '--no-password', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', [string]$testPort, '-U', 'fw9_migration_test', '-d', $Database)
    if ($File) { $psqlArguments += @('-f', (Join-Path $repositoryRoot $File)) }
    if ($Sql) { $psqlArguments += @('-c', $Sql) }
    Invoke-CheckedNative -Executable 'psql' -Arguments $psqlArguments -ExpectFailure:$ExpectFailure
}

function New-TestDatabase {
    param([string]$Database)
    # Database names are fixed internal identifiers, never external/user input.
    Invoke-TestSql -Database 'postgres' -Sql ('CREATE DATABASE ' + $Database)
    Invoke-TestSql -Database $Database -File 'test/wallet-migrations.fixture.sql'
}

try {
    foreach ($requiredBinary in @('initdb', 'pg_ctl', 'psql')) {
        $null = Get-Command $requiredBinary -ErrorAction Stop
    }
    $null = New-Item -ItemType Directory -Path $clusterRoot
    $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $portProbe.Start()
    $testPort = $portProbe.LocalEndpoint.Port
    $portProbe.Stop()

    Invoke-CheckedNative -Executable 'initdb' -Arguments @('-D', $clusterData, '-U', 'fw9_migration_test', '-A', 'trust', '--no-locale', '-E', 'UTF8')
    $serverOptions = '-h 127.0.0.1 -p ' + $testPort + ' -F'
    Invoke-CheckedNative -Executable 'pg_ctl' -Arguments @('-D', $clusterData, '-l', $clusterLog, '-o', $serverOptions, '-w', 'start')
    $clusterStarted = $true
    Invoke-TestSql -Database 'postgres' -Sql 'CREATE ROLE anon; CREATE ROLE authenticated;'

    New-TestDatabase -Database 'wallet_clean'
    Invoke-TestSql -Database 'wallet_clean' -File 'migrations/001_wallet_preflight.sql'
    Invoke-TestSql -Database 'wallet_clean' -File 'migrations/002_prepare_xendit_wallet.sql'
    Invoke-TestSql -Database 'wallet_clean' -File 'test/wallet-migrations.prepare.sql'
    Invoke-TestSql -Database 'wallet_clean' -File 'migrations/002_prepare_xendit_wallet.sql' -ExpectFailure
    Invoke-TestSql -Database 'wallet_clean' -File 'migrations/003_wallet_cutover.sql'
    Invoke-TestSql -Database 'wallet_clean' -File 'test/wallet-migrations.cutover.sql'
    Invoke-TestSql -Database 'wallet_clean' -File 'migrations/003_wallet_cutover.sql' -ExpectFailure
    Invoke-TestSql -Database 'wallet_clean' -Sql "SELECT test_support.assert_true((SELECT count(*) = 1 FROM public.wallet_entries), 'rerun must not duplicate opening balances');"
    Write-Output 'PASS: prepare, constraints, client grants, cutover, ledger, retry protection, and legacy write guards'

    $invalidDataCases = @(
        @{ Name = 'duplicate'; Sql = 'INSERT INTO public.profile(user_id, balance) VALUES (1, 0::numeric::money)' },
        @{ Name = 'orphan'; Sql = 'UPDATE public.transaction SET recipient_id = 9999 WHERE id = 1' },
        @{ Name = 'null_balance'; Sql = 'UPDATE public.profile SET balance = NULL WHERE user_id = 1' },
        @{ Name = 'negative'; Sql = 'UPDATE public.profile SET balance = (-1)::numeric::money WHERE user_id = 1' },
        @{ Name = 'fractional'; Sql = 'UPDATE public.transaction SET amount = 1.25::numeric::money WHERE id = 1' }
    )
    foreach ($invalidCase in $invalidDataCases) {
        $databaseName = 'wallet_' + $invalidCase.Name
        New-TestDatabase -Database $databaseName
        Invoke-TestSql -Database $databaseName -Sql $invalidCase.Sql
        Invoke-TestSql -Database $databaseName -File 'migrations/002_prepare_xendit_wallet.sql' -ExpectFailure
        Invoke-TestSql -Database $databaseName -Sql "SELECT test_support.assert_true(to_regclass('public.wallets') IS NULL AND to_regclass('public.app_schema_migrations') IS NULL, 'dirty data must roll back the entire migration');"
        Write-Output ('PASS: rejects ' + $invalidCase.Name + ' data atomically')
    }

    New-TestDatabase -Database 'wallet_cutover_guard'
    Invoke-TestSql -Database 'wallet_cutover_guard' -File 'migrations/002_prepare_xendit_wallet.sql'
    Invoke-TestSql -Database 'wallet_cutover_guard' -Sql "INSERT INTO public.users(email, password, username) VALUES ('missing@example.invalid', 'synthetic-password', 'missing');"
    Invoke-TestSql -Database 'wallet_cutover_guard' -File 'migrations/003_wallet_cutover.sql' -ExpectFailure
    Invoke-TestSql -Database 'wallet_cutover_guard' -Sql "SELECT test_support.assert_true((SELECT count(*) = 0 FROM public.wallets), 'missing profile must block cutover without moving balances');"
    Invoke-TestSql -Database 'wallet_cutover_guard' -Sql 'INSERT INTO public.profile(user_id) VALUES (3); INSERT INTO public.wallets(user_id) VALUES (1);'
    Invoke-TestSql -Database 'wallet_cutover_guard' -File 'migrations/003_wallet_cutover.sql' -ExpectFailure
    Write-Output 'PASS: cutover rejects missing profiles and pre-existing wallet data'
    Write-Output 'All wallet migration checks passed against a disposable local PostgreSQL cluster.'
} finally {
    if ($clusterStarted -or (Test-Path -LiteralPath (Join-Path $clusterData 'postmaster.pid'))) {
        Invoke-CheckedNative -Executable 'pg_ctl' -Arguments @('-D', $clusterData, '-m', 'fast', '-w', 'stop')
    }
    if (Test-Path -LiteralPath $clusterRoot) {
        $resolvedCluster = [IO.Path]::GetFullPath($clusterRoot)
        $allowedPrefix = Join-Path $temporaryRoot 'fw9-wallet-migrations-'
        if (-not $resolvedCluster.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing cleanup outside the generated temporary cluster directory'
        }
        Remove-Item -LiteralPath $resolvedCluster -Recurse -Force
    }
}
