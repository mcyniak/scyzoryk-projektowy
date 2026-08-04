using Xunit;

// FakeHealthServer.GetFreePort() wybiera "wolny" port przez tymczasowy Socket.Bind,
// od razu go zwalnia, i UZYWA TEGO SAMEGO numeru portu dla HttpListenera - miedzy
// zwolnieniem a uzyciem jest okno na rzeczywisty wyscig, jesli xUnit odpala inny
// test (z wlasnym FakeHealthServer) rownolegle na innym wątku i "ukradnie" ten sam
// numer portu. Zlapane realnie na CI (IsRespondingOnce_Returns200_True i
// WaitForHealthy_NeverHealthy_ProcessDead_NoExtensionAttempted padaly sporadycznie
// wylacznie kiedy dwa testy uzywajace FakeHealthServer trafily na ten sam port w
// tym samym momencie). Ten test suite jest maly (~50 testow, kilkanascie sekund) -
// sekwencyjne wykonanie kosztuje nieznacznie wiecej czasu, ale eliminuje wyscig
// calkowicie, zamiast dodawac zlozonosc do samego mechanizmu wyboru portu.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
