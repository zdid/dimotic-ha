ifndef CC
	CC = gcc 
endif

LD = $(CC)
CFLAGS = -Wall -g
LDFLAGS = -lusb-1.0
LDLIBS = 

tl-500 : tl-500.o
	$(LD) $+ -o $@ $(LDLIBS) $(LDFLAGS) 

tl-500.o : tl-500.c

clean :
	rm -f tl-500.o tl-500
	rm -f *~
	rm -f \#*\#

distclean: clean
	rm -f tl-500 
