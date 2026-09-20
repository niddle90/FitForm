CC      ?= cc
CFLAGS  ?= -O2 -Wall
LDLIBS  := -ljpeg -lm
TARGET  := jpegopt
SRC     := src/jpegopt.c

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $(TARGET) $(SRC) $(LDLIBS)

clean:
	rm -f $(TARGET)
