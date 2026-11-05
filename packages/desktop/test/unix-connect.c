#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
  struct sockaddr_un address;
  if (argc != 2) {
    fprintf(stderr, "unix-connect: usage: unix-connect <socket-path>\n");
    return 2;
  }
  size_t length = strlen(argv[1]);
  if (length == 0 || length >= sizeof address.sun_path) {
    fprintf(stderr, "unix-connect: path length %zu is outside 1..%zu\n", length, sizeof address.sun_path - 1);
    return 2;
  }
  memset(&address, 0, sizeof address);
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, argv[1], length);
  int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) {
    int failure = errno;
    fprintf(stderr, "unix-connect: socket: %s (errno %d)\n", strerror(failure), failure);
    return 1;
  }
  if (connect(descriptor, (struct sockaddr *)&address, sizeof address) < 0) {
    int failure = errno;
    fprintf(stderr, "unix-connect: connect: %s (errno %d)\n", strerror(failure), failure);
    close(descriptor);
    return 1;
  }
  close(descriptor);
  printf("unix-connect: connected\n");
  return 0;
}
